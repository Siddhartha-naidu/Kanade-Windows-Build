// The UI's only door to Rust. context/11 UI contract — commands in, events out. The UI never
// touches YouTube; everything here is a Tauri command or event payload.
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from './i18n.svelte';

export const isTauri = (): boolean =>
	typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);

type BrowserHandler = (event: { payload: any }) => void;
const browserListeners = new Map<string, Set<BrowserHandler>>();

export const emitBrowserEvent = (event: string, payload: any) => {
	const handlers = browserListeners.get(event);
	if (handlers) {
		for (const handler of handlers) {
			try {
				handler({ payload });
			} catch (err) {
				console.error(`[Browser Event Error] ${event}:`, err);
			}
		}
	}
};

const listen = async <T>(
	event: string,
	handler: (event: any) => void,
	options?: any
): Promise<UnlistenFn> => {
	if (!isTauri()) {
		if (!browserListeners.has(event)) {
			browserListeners.set(event, new Set());
		}
		browserListeners.get(event)!.add(handler);
		return () => {
			browserListeners.get(event)?.delete(handler);
		};
	}
	return tauriListen<T>(event, handler, options);
};

const invoke = async <T>(
	cmd: string,
	args?: Record<string, unknown> | any,
	options?: any
): Promise<T> => {
	if (!isTauri()) {
		return handleBrowserCommand<T>(cmd, args);
	}
	return tauriInvoke<T>(cmd, args, options);
};

// --- Browser Mode Fallback Implementation (Piped / Invidious & YouTube IFrame API) ---------

const PIPED_INSTANCES = [
	'https://api.piped.private.coffee',
	'https://pipedapi.kavin.rocks',
	'https://pipedapi.tokhmi.xyz'
];

const INVIDIOUS_INSTANCES = [
	'https://yt.chocolatemoo53.com',
	'https://invidious.materialio.us',
	'https://inv.nadeko.net'
];

async function fetchWithFallback<T>(
	urlBuilder: (base: string) => string,
	instances: string[],
	timeoutMs = 4500
): Promise<T | null> {
	for (const base of instances) {
		try {
			const url = urlBuilder(base);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(timer);
			if (res.ok) {
				return (await res.json()) as T;
			}
		} catch {
			// continue to next candidate instance
		}
	}
	return null;
}

function formatDuration(sec: number): string {
	if (!sec || isNaN(sec) || sec <= 0) return '0:00';
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function parseDuration(str?: string): number {
	if (!str) return 0;
	const parts = str.split(':').map((p) => parseInt(p, 10));
	if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
		return parts[0] * 60 + parts[1];
	}
	if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2];
	}
	return 0;
}

const BROWSER_SETTINGS_KEY = 'kanade_browser_settings';
function getBrowserSettings(): Record<string, string> {
	if (typeof window === 'undefined') {
		return { autoplay: 'true', discord_rpc: 'false', lastfm_config: '{}' };
	}
	try {
		const raw = localStorage.getItem(BROWSER_SETTINGS_KEY);
		if (raw) return JSON.parse(raw);
	} catch {}
	return { autoplay: 'true', discord_rpc: 'false', lastfm_config: '{}' };
}

function setBrowserSetting(key: string, value: string): void {
	if (typeof window === 'undefined') return;
	try {
		const current = getBrowserSettings();
		current[key] = value;
		localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(current));
	} catch {}
}

const BROWSER_RATINGS_KEY = 'kanade_browser_ratings';
function getBrowserRating(videoId: string): Rating {
	if (typeof window === 'undefined') return 'indifferent';
	try {
		const raw = localStorage.getItem(BROWSER_RATINGS_KEY);
		if (raw) {
			const map = JSON.parse(raw);
			return map[videoId] || 'indifferent';
		}
	} catch {}
	return 'indifferent';
}

function setBrowserRating(videoId: string, rating: Rating): void {
	if (typeof window === 'undefined') return;
	try {
		const raw = localStorage.getItem(BROWSER_RATINGS_KEY);
		const map = raw ? JSON.parse(raw) : {};
		map[videoId] = rating;
		localStorage.setItem(BROWSER_RATINGS_KEY, JSON.stringify(map));
	} catch {}
}

async function browserSearchAll(query: string): Promise<SearchResults> {
	const trimmed = query.trim();
	if (!trimmed) {
		return { top: [], songs: [], albums: [], artists: [], playlists: [] };
	}

	const [pipedSongs, pipedAlbums, pipedArtists] = await Promise.all([
		fetchWithFallback<{ items: any[] }>(
			(base) => `${base}/search?q=${encodeURIComponent(trimmed)}&filter=music_songs`,
			PIPED_INSTANCES
		),
		fetchWithFallback<{ items: any[] }>(
			(base) => `${base}/search?q=${encodeURIComponent(trimmed)}&filter=music_albums`,
			PIPED_INSTANCES
		),
		fetchWithFallback<{ items: any[] }>(
			(base) => `${base}/search?q=${encodeURIComponent(trimmed)}&filter=music_artists`,
			PIPED_INSTANCES
		)
	]);

	let songs: BrowseItem[] = [];
	let albums: BrowseItem[] = [];
	let artists: BrowseItem[] = [];
	let playlists: BrowseItem[] = [];

	if (pipedSongs && Array.isArray(pipedSongs.items)) {
		songs = pipedSongs.items
			.filter((it) => it && (it.type === 'stream' || it.url?.includes('/watch?v=')))
			.map((it) => {
				const id = it.url.replace('/watch?v=', '');
				const duration = typeof it.duration === 'number' ? formatDuration(it.duration) : undefined;
				return {
					kind: 'song' as const,
					id,
					title: it.title,
					subtitle: it.uploaderName || 'Unknown Artist',
					thumbnail: it.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
					duration,
					artistRuns: it.uploaderName
						? [{ text: it.uploaderName, id: it.uploaderUrl?.replace('/channel/', '') }]
						: undefined
				};
			});
	}

	if (pipedAlbums && Array.isArray(pipedAlbums.items)) {
		albums = pipedAlbums.items.map((it) => ({
			kind: 'album' as const,
			id: it.url?.replace('/playlist?list=', '') || it.name,
			title: it.name || it.title || 'Album',
			subtitle: it.uploaderName,
			thumbnail: it.thumbnail
		}));
	}

	if (pipedArtists && Array.isArray(pipedArtists.items)) {
		artists = pipedArtists.items.map((it) => ({
			kind: 'artist' as const,
			id: it.url?.replace('/channel/', '') || it.name,
			title: it.name || it.title || 'Artist',
			subtitle: 'Artist',
			thumbnail: it.thumbnail
		}));
	}

	// Fallback to Invidious search if songs list was empty
	if (songs.length === 0) {
		const invidiousRes = await fetchWithFallback<any[]>(
			(base) => `${base}/api/v1/search?q=${encodeURIComponent(trimmed)}&type=video`,
			INVIDIOUS_INSTANCES
		);
		if (invidiousRes && Array.isArray(invidiousRes)) {
			songs = invidiousRes
				.filter((it) => it && (it.type === 'video' || it.videoId))
				.map((it) => ({
					kind: 'song' as const,
					id: it.videoId,
					title: it.title,
					subtitle: it.author || 'Unknown Artist',
					thumbnail:
						it.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`,
					duration: it.lengthSeconds ? formatDuration(it.lengthSeconds) : undefined,
					artistRuns: it.author ? [{ text: it.author, id: it.authorId }] : undefined
				}));
		}
	}

	const top: BrowseItem[] = [];
	if (songs.length > 0) top.push(songs[0]);
	else if (albums.length > 0) top.push(albums[0]);
	else if (artists.length > 0) top.push(artists[0]);

	return { top, songs, albums, artists, playlists };
}

async function browserSearch(query: string): Promise<SongItem[]> {
	const res = await browserSearchAll(query);
	return res.songs.map((b) => ({
		video_id: b.id,
		title: b.title,
		artists: b.subtitle || 'Unknown Artist',
		artist_id: b.artistRuns?.[0]?.id,
		artist_runs: b.artistRuns,
		duration: b.duration || '3:30',
		thumbnail: b.thumbnail,
		album_id: b.albumId,
		rating: getBrowserRating(b.id),
		is_video: false
	}));
}

async function browserSuggestions(query: string): Promise<SearchSuggestions> {
	if (!query.trim()) return { queries: [], items: [] };

	const piped = await fetchWithFallback<string[]>(
		(base) => `${base}/suggestions?query=${encodeURIComponent(query)}`,
		PIPED_INSTANCES
	);

	let list = Array.isArray(piped) ? piped : [];
	if (list.length === 0) {
		const inv = await fetchWithFallback<{ suggestions?: string[] }>(
			(base) => `${base}/api/v1/search/suggestions?q=${encodeURIComponent(query)}`,
			INVIDIOUS_INSTANCES
		);
		if (inv && Array.isArray(inv.suggestions)) {
			list = inv.suggestions;
		}
	}

	return {
		queries: list.slice(0, 8).map((text) => ({ text, history: false })),
		items: []
	};
}

async function browserSong(videoId: string): Promise<SongItem> {
	try {
		const oembed = await fetch(
			`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
		).then((r) => r.json());
		if (oembed && oembed.title) {
			return {
				video_id: videoId,
				title: oembed.title,
				artists: oembed.author_name || 'YouTube',
				duration: '3:30',
				thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
				rating: getBrowserRating(videoId),
				is_video: false
			};
		}
	} catch {}

	const inv = await fetchWithFallback<any>(
		(base) => `${base}/api/v1/videos/${videoId}`,
		INVIDIOUS_INSTANCES
	);
	if (inv && inv.title) {
		return {
			video_id: videoId,
			title: inv.title,
			artists: inv.author || 'YouTube',
			artist_id: inv.authorId,
			duration: inv.lengthSeconds ? formatDuration(inv.lengthSeconds) : '3:30',
			thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
			rating: getBrowserRating(videoId),
			is_video: false
		};
	}

	return {
		video_id: videoId,
		title: 'Track ' + videoId,
		artists: 'YouTube Music',
		duration: '3:30',
		thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
		rating: getBrowserRating(videoId),
		is_video: false
	};
}

async function browserHome(): Promise<HomePage> {
	const trendingRes = await fetchWithFallback<any[]>(
		(base) => `${base}/trending?region=US`,
		PIPED_INSTANCES
	);

	let items: BrowseItem[] = [];
	if (trendingRes && Array.isArray(trendingRes)) {
		items = trendingRes
			.filter((it) => it && (it.type === 'stream' || it.url?.includes('/watch?v=')))
			.slice(0, 20)
			.map((it) => {
				const id = it.url.replace('/watch?v=', '');
				const duration =
					typeof it.duration === 'number' && it.duration > 0
						? formatDuration(it.duration)
						: undefined;
				return {
					kind: 'song' as const,
					id,
					title: it.title,
					subtitle: it.uploaderName || 'Trending',
					thumbnail: it.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
					duration,
					artistRuns: it.uploaderName
						? [{ text: it.uploaderName, id: it.uploaderUrl?.replace('/channel/', '') }]
						: undefined
				};
			});
	}

	if (items.length === 0) {
		const invTrending = await fetchWithFallback<any[]>(
			(base) => `${base}/api/v1/trending?type=music`,
			INVIDIOUS_INSTANCES
		);
		if (invTrending && Array.isArray(invTrending)) {
			items = invTrending.slice(0, 20).map((it) => ({
				kind: 'song' as const,
				id: it.videoId,
				title: it.title,
				subtitle: it.author || 'Trending',
				thumbnail:
					it.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`,
				duration: it.lengthSeconds ? formatDuration(it.lengthSeconds) : undefined,
				artistRuns: it.author ? [{ text: it.author, id: it.authorId }] : undefined
			}));
		}
	}

	// Fallback curated selection if all external APIs are unreachable
	if (items.length === 0) {
		items = [
			{
				kind: 'song',
				id: 'u5CVsCnxyXg',
				title: 'No Surprises',
				subtitle: 'Radiohead',
				duration: '3:48',
				thumbnail: 'https://i.ytimg.com/vi/u5CVsCnxyXg/hqdefault.jpg'
			},
			{
				kind: 'song',
				id: 'QtXby3twMmI',
				title: 'Adventure Of A Lifetime',
				subtitle: 'Coldplay',
				duration: '5:15',
				thumbnail: 'https://i.ytimg.com/vi/QtXby3twMmI/hqdefault.jpg'
			},
			{
				kind: 'song',
				id: 'fJ9rUzIMcZQ',
				title: 'Bohemian Rhapsody',
				subtitle: 'Queen',
				duration: '5:55',
				thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg'
			},
			{
				kind: 'song',
				id: '5NV6Rdv1a3I',
				title: 'Get Lucky',
				subtitle: 'Daft Punk ft. Pharrell Williams',
				duration: '4:08',
				thumbnail: 'https://i.ytimg.com/vi/5NV6Rdv1a3I/hqdefault.jpg'
			},
			{
				kind: 'song',
				id: 'kJQP7kiw5Fk',
				title: 'Despacito',
				subtitle: 'Luis Fonsi ft. Daddy Yankee',
				duration: '4:41',
				thumbnail: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
			},
			{
				kind: 'song',
				id: 'JGwWNGJdvx8',
				title: 'Shape of You',
				subtitle: 'Ed Sheeran',
				duration: '3:53',
				thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg'
			}
		];
	}

	const half = Math.ceil(items.length / 2);
	const quickPicks = items.slice(0, half);
	const trending = items.slice(half);

	return {
		chips: [
			{ title: 'Energize', params: 'energize' },
			{ title: 'Relax', params: 'relax' },
			{ title: 'Workout', params: 'workout' },
			{ title: 'Commute', params: 'commute' },
			{ title: 'Focus', params: 'focus' }
		],
		sections: [
			{
				title: 'Quick picks',
				kind: 'quick_picks',
				items: quickPicks
			},
			{
				title: 'Trending',
				kind: 'fresh_finds',
				items: trending
			},
			{
				title: 'Listen again',
				kind: 'listen_again',
				items: items.slice(0, 8)
			}
		]
	};
}

async function browserPlaylist(id: string): Promise<PlaylistPage> {
	const inv = await fetchWithFallback<any>(
		(base) => `${base}/api/v1/playlists/${id}`,
		INVIDIOUS_INSTANCES
	);

	if (inv && Array.isArray(inv.videos)) {
		const items: SongItem[] = inv.videos.map((v: any) => ({
			video_id: v.videoId,
			title: v.title,
			artists: v.author || 'Artist',
			duration: v.lengthSeconds ? formatDuration(v.lengthSeconds) : '3:30',
			thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
			rating: getBrowserRating(v.videoId),
			is_video: false
		}));
		return {
			title: inv.title || 'Playlist',
			subtitle: `${inv.videoCount || items.length} tracks`,
			thumbnail: inv.playlistThumbnail || items[0]?.thumbnail,
			items,
			owned: false,
			collaborative: false
		};
	}

	return {
		title: 'Playlist',
		subtitle: '0 tracks',
		items: [],
		owned: false,
		collaborative: false
	};
}

async function browserAlbum(id: string): Promise<AlbumPage> {
	const pl = await browserPlaylist(id);
	return {
		title: pl.title,
		artist: pl.items[0]?.artists || 'Unknown Artist',
		thumbnail: pl.thumbnail,
		items: pl.items,
		inLibrary: false,
		playlistId: id
	};
}

async function fetchAudioStreamUrls(videoId: string): Promise<string[]> {
	const urls: string[] = [];

	// 1. Query Invidious instances for adaptiveFormats
	for (const base of INVIDIOUS_INSTANCES) {
		try {
			const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
				signal: AbortSignal.timeout(4000)
			});
			if (!res.ok) continue;
			const data = await res.json();
			const audioFormats = data.adaptiveFormats?.filter(
				(f: any) =>
					f?.url && (f.type?.includes('audio') || f.container === 'm4a' || f.container === 'webm')
			);
			if (audioFormats && audioFormats.length > 0) {
				// Prioritize m4a/mp4a (itag 140 or 139), then webm/opus (itag 251, 250, 249)
				audioFormats.sort((a: any, b: any) => {
					const aIsM4a = a.itag === '140' || a.itag === '139' || a.type?.includes('audio/mp4');
					const bIsM4a = b.itag === '140' || b.itag === '139' || b.type?.includes('audio/mp4');
					if (aIsM4a && !bIsM4a) return -1;
					if (!aIsM4a && bIsM4a) return 1;
					return 0;
				});
				for (const af of audioFormats) {
					if (af.url && !urls.includes(af.url)) {
						urls.push(af.url);
					}
				}
				if (urls.length >= 2) break;
			}
		} catch {}
	}

	// 2. Query Piped instances for audioStreams
	for (const base of PIPED_INSTANCES) {
		try {
			const res = await fetch(`${base}/streams/${videoId}`, {
				signal: AbortSignal.timeout(4000)
			});
			if (!res.ok) continue;
			const data = await res.json();
			if (Array.isArray(data.audioStreams)) {
				for (const stream of data.audioStreams) {
					if (stream?.url && !urls.includes(stream.url)) {
						urls.push(stream.url);
					}
				}
				if (urls.length >= 4) break;
			}
		} catch {}
	}

	return urls;
}

class BrowserAudioController {
	private audio: HTMLAudioElement | null = null;
	private ytPlayer: any = null;
	private ytReady = false;
	private ytLoading = false;
	private ytTickInterval: any = null;
	private activeEngine: 'html5' | 'iframe' | 'none' = 'none';

	private candidateUrls: string[] = [];
	private candidateIndex = 0;
	private playSessionId = 0;
	private currentSong: SongItem | null = null;

	public snapshot: PlaybackSnapshot = {
		now: null,
		paused: true,
		position: 0,
		duration: 0,
		volume: 80
	};

	public queue: QueueState = {
		items: [],
		currentIndex: 0,
		shuffle: false,
		repeat: 'off',
		sourceName: null,
		sourceId: null,
		prevTrack: null
	};

	constructor() {
		if (typeof window !== 'undefined') {
			this.ensureAudio();
		}
	}

	public ensureAudio(): HTMLAudioElement | null {
		if (typeof window === 'undefined') return null;
		if (this.audio) return this.audio;

		this.audio = new Audio();
		this.audio.preload = 'auto';
		this.audio.volume = Math.max(0, Math.min(1, this.snapshot.volume / 100));

		this.audio.addEventListener('timeupdate', () => {
			if (this.activeEngine !== 'html5' || !this.audio) return;
			const pos = this.audio.currentTime;
			this.snapshot.position = pos;
			emitBrowserEvent('position', { position: pos });
		});

		this.audio.addEventListener('durationchange', () => {
			if (this.activeEngine !== 'html5' || !this.audio) return;
			const dur = this.audio.duration;
			if (typeof dur === 'number' && !isNaN(dur) && dur > 0) {
				this.snapshot.duration = dur;
				emitBrowserEvent('duration', { duration: dur });
			}
		});

		this.audio.addEventListener('loadedmetadata', () => {
			if (this.activeEngine !== 'html5' || !this.audio) return;
			const dur = this.audio.duration;
			if (typeof dur === 'number' && !isNaN(dur) && dur > 0) {
				this.snapshot.duration = dur;
				emitBrowserEvent('duration', { duration: dur });
			}
		});

		this.audio.addEventListener('play', () => {
			if (this.activeEngine !== 'html5') return;
			this.snapshot.paused = false;
			emitBrowserEvent('playback-state', 'playing');
		});

		this.audio.addEventListener('pause', () => {
			if (this.activeEngine !== 'html5') return;
			this.snapshot.paused = true;
			emitBrowserEvent('playback-state', 'paused');
		});

		this.audio.addEventListener('ended', () => {
			if (this.activeEngine === 'html5') {
				this.onTrackEnded();
			}
		});

		this.audio.addEventListener('error', (e) => {
			if (this.activeEngine === 'html5') {
				console.warn(
					`[HTML5 Audio] Error on candidate ${this.candidateIndex} (${this.candidateUrls[this.candidateIndex]}):`,
					e
				);
				const sessionId = this.playSessionId;
				const song = this.currentSong;
				this.candidateIndex++;
				if (song && sessionId === this.playSessionId) {
					this.playNextCandidate(sessionId, song);
				}
			}
		});

		return this.audio;
	}

	private async ensureIFramePlayer(): Promise<any> {
		if (typeof window === 'undefined') return Promise.resolve(null);
		if (this.ytPlayer && this.ytReady) return Promise.resolve(this.ytPlayer);
		if (this.ytLoading) {
			return new Promise((resolve) => {
				const check = setInterval(() => {
					if (this.ytReady && this.ytPlayer) {
						clearInterval(check);
						resolve(this.ytPlayer);
					}
				}, 100);
			});
		}
		this.ytLoading = true;

		return new Promise((resolve) => {
			const initYT = () => {
				let host = document.getElementById('kanade-browser-audio-host');
				if (!host) {
					host = document.createElement('div');
					host.id = 'kanade-browser-audio-host';
					host.style.position = 'fixed';
					host.style.width = '1px';
					host.style.height = '1px';
					host.style.bottom = '0';
					host.style.right = '0';
					host.style.opacity = '0.001';
					host.style.pointerEvents = 'none';
					host.style.zIndex = '-9999';
					document.body.appendChild(host);
				}
				const container = document.createElement('div');
				host.appendChild(container);

				this.ytPlayer = new (window as any).YT.Player(container, {
					height: '1',
					width: '1',
					playerVars: {
						autoplay: 1,
						controls: 0,
						disablekb: 1,
						fs: 0,
						rel: 0,
						origin: window.location.origin
					},
					events: {
						onReady: (event: any) => {
							this.ytReady = true;
							this.ytLoading = false;
							try {
								event.target.setVolume(this.snapshot.volume);
							} catch {}
							resolve(this.ytPlayer);
						},
						onStateChange: (event: any) => {
							if (this.activeEngine !== 'iframe') return;
							const YT = (window as any).YT;
							if (!YT) return;
							if (event.data === YT.PlayerState.PLAYING) {
								this.snapshot.paused = false;
								emitBrowserEvent('playback-state', 'playing');
								this.startIFrameTick();
							} else if (event.data === YT.PlayerState.PAUSED) {
								this.snapshot.paused = true;
								emitBrowserEvent('playback-state', 'paused');
								this.stopIFrameTick();
							} else if (event.data === YT.PlayerState.ENDED) {
								this.onTrackEnded();
							}
						},
						onError: (err: any) => {
							console.warn('[YT Fallback Player] Error event:', err?.data);
						}
					}
				});
			};

			if ((window as any).YT && (window as any).YT.Player) {
				initYT();
			} else {
				const prev = (window as any).onYouTubeIframeAPIReady;
				(window as any).onYouTubeIframeAPIReady = () => {
					if (prev) prev();
					initYT();
				};
				if (!document.getElementById('kanade-yt-iframe-api')) {
					const script = document.createElement('script');
					script.id = 'kanade-yt-iframe-api';
					script.src = 'https://www.youtube.com/iframe_api';
					document.head.appendChild(script);
				}
			}
		});
	}

	private startIFrameTick() {
		this.stopIFrameTick();
		this.ytTickInterval = setInterval(() => {
			if (this.activeEngine !== 'iframe' || !this.ytPlayer || !this.ytReady) return;
			try {
				const pos = this.ytPlayer.getCurrentTime();
				const dur = this.ytPlayer.getDuration();
				if (typeof pos === 'number' && !isNaN(pos)) {
					this.snapshot.position = pos;
					emitBrowserEvent('position', { position: pos });
				}
				if (typeof dur === 'number' && !isNaN(dur) && dur > 0) {
					if (this.snapshot.duration !== dur) {
						this.snapshot.duration = dur;
						emitBrowserEvent('duration', { duration: dur });
					}
				}
			} catch {}
		}, 250);
	}

	private stopIFrameTick() {
		if (this.ytTickInterval) {
			clearInterval(this.ytTickInterval);
			this.ytTickInterval = null;
		}
	}

	private stopCurrent() {
		if (this.audio) {
			try {
				this.audio.pause();
				this.audio.removeAttribute('src');
				this.audio.load();
			} catch {}
		}
		if (this.ytPlayer && typeof this.ytPlayer.stopVideo === 'function') {
			try {
				this.ytPlayer.stopVideo();
			} catch {}
		}
		this.stopIFrameTick();
		this.activeEngine = 'none';
	}

	private async loadAndPlay(item: SongItem) {
		const sessionId = ++this.playSessionId;
		this.currentSong = item;
		const durSec = item.duration ? parseDuration(item.duration) : 0;

		this.stopCurrent();

		this.snapshot.now = {
			videoId: item.video_id,
			title: item.title,
			artists: item.artists,
			artistId: item.artist_id,
			artistRuns: item.artist_runs,
			thumbnail: item.thumbnail,
			duration: item.duration,
			album: item.album || null,
			streamClient: 'browser',
			rating: item.rating || getBrowserRating(item.video_id),
			isVideo: item.is_video || false
		};
		this.snapshot.paused = false;
		this.snapshot.position = 0;
		this.snapshot.duration = durSec;

		emitBrowserEvent('now-playing', this.snapshot.now);
		emitBrowserEvent('position', { position: 0 });
		if (durSec > 0) {
			emitBrowserEvent('duration', { duration: durSec });
		}
		emitBrowserEvent('playback-state', 'playing');

		// Fetch candidate URLs from public instances
		this.candidateUrls = await fetchAudioStreamUrls(item.video_id);
		this.candidateIndex = 0;

		if (sessionId !== this.playSessionId) return;

		if (this.candidateUrls.length > 0) {
			this.activeEngine = 'html5';
			this.playNextCandidate(sessionId, item);
		} else {
			// No direct stream URLs available -> immediately fall back to YouTube IFrame
			await this.fallbackToIFrame(sessionId, item);
		}
	}

	private playNextCandidate(sessionId: number, item: SongItem) {
		if (sessionId !== this.playSessionId) return;

		if (this.candidateIndex >= this.candidateUrls.length) {
			// All direct HTML5 candidate stream URLs failed -> fall back to YouTube IFrame player
			this.fallbackToIFrame(sessionId, item);
			return;
		}

		const streamUrl = this.candidateUrls[this.candidateIndex];
		const audio = this.ensureAudio();
		if (!audio) return;

		this.activeEngine = 'html5';
		audio.src = streamUrl;
		audio.currentTime = 0;
		const playPromise = audio.play();
		if (playPromise !== undefined) {
			playPromise.catch((err) => {
				console.warn(`[HTML5 Audio] Candidate ${this.candidateIndex} play failed:`, err);
				if (sessionId === this.playSessionId && this.activeEngine === 'html5') {
					this.candidateIndex++;
					this.playNextCandidate(sessionId, item);
				}
			});
		}
	}

	private async fallbackToIFrame(sessionId: number, item: SongItem) {
		if (sessionId !== this.playSessionId) return;
		console.info(
			`[Browser Audio] Falling back to YouTube IFrame player for ${item.title} (${item.video_id})`
		);

		if (this.audio) {
			try {
				this.audio.pause();
				this.audio.removeAttribute('src');
				this.audio.load();
			} catch {}
		}
		this.activeEngine = 'iframe';

		try {
			const player = await this.ensureIFramePlayer();
			if (sessionId !== this.playSessionId) return;
			if (player && typeof player.loadVideoById === 'function') {
				player.loadVideoById(item.video_id);
				player.playVideo();
			}
		} catch (err) {
			console.error('[YT Fallback Player] Failed to play video:', err);
		}
	}

	private onTrackEnded() {
		if (this.queue.repeat === 'one') {
			this.seek(0);
			if (this.activeEngine === 'iframe') {
				this.ytPlayer?.playVideo();
			} else {
				this.audio?.play().catch(() => {});
			}
			return;
		}
		if (this.queue.currentIndex + 1 < this.queue.items.length) {
			this.playIndex(this.queue.currentIndex + 1);
		} else if (this.queue.repeat === 'all' && this.queue.items.length > 0) {
			this.playIndex(0);
		} else {
			this.snapshot.paused = true;
			emitBrowserEvent('playback-state', 'paused');
		}
	}

	public async play(item: SongItem) {
		this.queue = {
			items: [item],
			currentIndex: 0,
			shuffle: false,
			repeat: this.queue.repeat,
			sourceName: null,
			sourceId: null,
			prevTrack: null
		};
		emitBrowserEvent('queue-changed', this.queue);
		await this.loadAndPlay(item);
	}

	public async playIndex(index: number) {
		if (index >= 0 && index < this.queue.items.length) {
			this.queue.currentIndex = index;
			emitBrowserEvent('queue-index', {
				currentIndex: index,
				shuffle: this.queue.shuffle,
				repeat: this.queue.repeat,
				sourceName: this.queue.sourceName,
				sourceId: this.queue.sourceId,
				prevTrack: this.queue.prevTrack,
				current: this.queue.items[index] || null
			});
			await this.loadAndPlay(this.queue.items[index]);
		}
	}

	public async playPlaylist(
		items: SongItem[],
		start: number | null,
		sourceId?: string,
		sourceName?: string,
		shuffle?: boolean
	) {
		if (!items.length) return;
		let playlistItems = [...items];
		let idx = start !== null && start !== undefined ? start : 0;
		if (shuffle) {
			const picked = playlistItems[idx];
			const rest = playlistItems.filter((_, i) => i !== idx);
			for (let i = rest.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[rest[i], rest[j]] = [rest[j], rest[i]];
			}
			playlistItems = picked ? [picked, ...rest] : rest;
			idx = 0;
		}

		this.queue = {
			items: playlistItems,
			currentIndex: idx,
			shuffle: !!shuffle,
			repeat: this.queue.repeat,
			sourceName: sourceName ?? null,
			sourceId: sourceId ?? null,
			prevTrack: null
		};
		emitBrowserEvent('queue-changed', this.queue);
		if (playlistItems[idx]) {
			await this.loadAndPlay(playlistItems[idx]);
		}
	}

	public async startRadio(kind: string, id: string, name?: string) {
		const current = await browserSong(id);
		const searchResults = await browserSearch(current.artists || current.title);
		const queueItems = [current, ...searchResults.filter((s) => s.video_id !== id).slice(0, 15)];
		await this.playPlaylist(queueItems, 0, id, name || `${current.title} Radio`, false);
	}

	public playNext(items: SongItem[], from?: string) {
		const cur = this.queue.currentIndex;
		const marked = items.map((it) => ({ ...it, queued: true, queued_from: from }));
		this.queue.items.splice(cur + 1, 0, ...marked);
		emitBrowserEvent('queue-changed', this.queue);
	}

	public addToQueue(items: SongItem[], from?: string) {
		const marked = items.map((it) => ({ ...it, queued_end: true, queued_from: from }));
		this.queue.items.push(...marked);
		emitBrowserEvent('queue-changed', this.queue);
	}

	public clearQueued() {
		this.queue.items = this.queue.items.filter(
			(it, idx) => idx <= this.queue.currentIndex || (!it.queued && !it.queued_end)
		);
		emitBrowserEvent('queue-changed', this.queue);
	}

	public removeFromQueue(index: number) {
		if (index > this.queue.currentIndex && index < this.queue.items.length) {
			this.queue.items.splice(index, 1);
			emitBrowserEvent('queue-changed', this.queue);
		}
	}

	public moveInQueue(from: number, to: number) {
		if (from !== to && from < this.queue.items.length && to < this.queue.items.length) {
			const [item] = this.queue.items.splice(from, 1);
			this.queue.items.splice(to, 0, item);
			emitBrowserEvent('queue-changed', this.queue);
		}
	}

	public togglePause() {
		if (this.activeEngine === 'iframe') {
			if (!this.ytPlayer) return;
			if (this.snapshot.paused) {
				try {
					this.ytPlayer.playVideo();
				} catch {}
				this.snapshot.paused = false;
				emitBrowserEvent('playback-state', 'playing');
				this.startIFrameTick();
			} else {
				try {
					this.ytPlayer.pauseVideo();
				} catch {}
				this.snapshot.paused = true;
				emitBrowserEvent('playback-state', 'paused');
				this.stopIFrameTick();
			}
		} else {
			const audio = this.ensureAudio();
			if (!audio) return;
			if (audio.paused) {
				audio.play().catch(() => {});
			} else {
				audio.pause();
			}
		}
	}

	public seek(position: number) {
		if (this.activeEngine === 'iframe') {
			try {
				this.ytPlayer?.seekTo(position, true);
			} catch {}
		} else {
			const audio = this.ensureAudio();
			if (audio) {
				try {
					audio.currentTime = position;
				} catch {}
			}
		}
		this.snapshot.position = position;
		emitBrowserEvent('position', { position });
	}

	public setVolume(vol: number) {
		this.snapshot.volume = vol;
		if (this.audio) {
			this.audio.volume = Math.max(0, Math.min(1, vol / 100));
		}
		if (this.ytPlayer && typeof this.ytPlayer.setVolume === 'function') {
			try {
				this.ytPlayer.setVolume(vol);
			} catch {}
		}
		emitBrowserEvent('volume', vol);
	}

	public setPlaybackParams(speed: number) {
		if (this.audio && typeof speed === 'number' && speed > 0) {
			this.audio.playbackRate = speed;
		}
		if (this.ytPlayer && typeof this.ytPlayer.setPlaybackRate === 'function') {
			try {
				this.ytPlayer.setPlaybackRate(speed);
			} catch {}
		}
	}

	public nextTrack() {
		if (this.queue.currentIndex + 1 < this.queue.items.length) {
			this.playIndex(this.queue.currentIndex + 1);
		} else if (this.queue.repeat === 'all' && this.queue.items.length > 0) {
			this.playIndex(0);
		}
	}

	public prevTrack() {
		if (this.snapshot.position > 3) {
			this.seek(0);
		} else if (this.queue.currentIndex > 0) {
			this.playIndex(this.queue.currentIndex - 1);
		} else {
			this.seek(0);
		}
	}

	public toggleShuffle() {
		this.queue.shuffle = !this.queue.shuffle;
		emitBrowserEvent('queue-index', {
			currentIndex: this.queue.currentIndex,
			shuffle: this.queue.shuffle,
			repeat: this.queue.repeat,
			sourceName: this.queue.sourceName,
			sourceId: this.queue.sourceId,
			prevTrack: this.queue.prevTrack,
			current: this.queue.items[this.queue.currentIndex] || null
		});
	}

	public setRepeat(mode: RepeatMode) {
		this.queue.repeat = mode;
		emitBrowserEvent('queue-index', {
			currentIndex: this.queue.currentIndex,
			shuffle: this.queue.shuffle,
			repeat: this.queue.repeat,
			sourceName: this.queue.sourceName,
			sourceId: this.queue.sourceId,
			prevTrack: this.queue.prevTrack,
			current: this.queue.items[this.queue.currentIndex] || null
		});
	}
}

const browserAudio = new BrowserAudioController();

async function handleBrowserCommand<T>(cmd: string, args: any): Promise<T> {
	switch (cmd) {
		case 'search':
			return (await browserSearch(args?.query || '')) as unknown as T;
		case 'search_videos':
			return (await browserSearch(args?.query || '')) as unknown as T;
		case 'search_all':
			return (await browserSearchAll(args?.query || '')) as unknown as T;
		case 'search_suggestions':
			return (await browserSuggestions(args?.query || '')) as unknown as T;
		case 'search_cards': {
			const all = await browserSearchAll(args?.query || '');
			if (args?.category === 'albums') return all.albums as unknown as T;
			if (args?.category === 'artists') return all.artists as unknown as T;
			return all.playlists as unknown as T;
		}
		case 'song':
			return (await browserSong(args?.videoId)) as unknown as T;
		case 'get_home':
		case 'get_home_more':
			return (await browserHome()) as unknown as T;
		case 'play':
			return (await browserAudio.play(args?.item)) as unknown as T;
		case 'play_index':
			return (await browserAudio.playIndex(args?.index)) as unknown as T;
		case 'play_playlist':
			return (await browserAudio.playPlaylist(
				args?.items || [],
				args?.start,
				args?.sourceId,
				args?.sourceName,
				args?.shuffle
			)) as unknown as T;
		case 'start_radio':
			return (await browserAudio.startRadio(
				args?.kind,
				args?.id,
				args?.name
			)) as unknown as T;
		case 'play_next':
			browserAudio.playNext(args?.items || [], args?.from);
			return undefined as unknown as T;
		case 'add_to_queue':
			browserAudio.addToQueue(args?.items || [], args?.from);
			return undefined as unknown as T;
		case 'clear_queued':
			browserAudio.clearQueued();
			return undefined as unknown as T;
		case 'remove_from_queue':
			browserAudio.removeFromQueue(args?.index);
			return undefined as unknown as T;
		case 'move_in_queue':
			browserAudio.moveInQueue(args?.from, args?.to);
			return undefined as unknown as T;
		case 'toggle_pause':
			browserAudio.togglePause();
			return undefined as unknown as T;
		case 'seek':
			browserAudio.seek(args?.position);
			return undefined as unknown as T;
		case 'set_volume':
			browserAudio.setVolume(args?.volume);
			return undefined as unknown as T;
		case 'next_track':
			browserAudio.nextTrack();
			return undefined as unknown as T;
		case 'prev_track':
			browserAudio.prevTrack();
			return undefined as unknown as T;
		case 'toggle_shuffle':
			browserAudio.toggleShuffle();
			return undefined as unknown as T;
		case 'set_repeat':
			browserAudio.setRepeat(args?.mode);
			return undefined as unknown as T;
		case 'set_playback_params':
			if (typeof args?.speed === 'number') {
				browserAudio.setPlaybackParams(args.speed);
			}
			return undefined as unknown as T;
		case 'rate':
			if (args?.videoId && args?.rating) {
				setBrowserRating(args.videoId, args.rating);
				if (browserAudio.snapshot.now && browserAudio.snapshot.now.videoId === args.videoId) {
					browserAudio.snapshot.now.rating = args.rating;
				}
				emitBrowserEvent('rating', { videoId: args.videoId, rating: args.rating });
			}
			return undefined as unknown as T;
		case 'get_playback':
			return browserAudio.snapshot as unknown as T;
		case 'get_queue':
			return browserAudio.queue as unknown as T;
		case 'get_album':
			return (await browserAlbum(args?.id)) as unknown as T;
		case 'get_playlist':
			return (await browserPlaylist(args?.id)) as unknown as T;
		case 'get_artist':
			return {
				channelId: args?.id,
				subscribed: false,
				topSongs: [],
				sections: []
			} as unknown as T;
		case 'get_library':
		case 'local_playlists':
		case 'get_library_albums':
		case 'get_library_artists':
		case 'get_library_subscriptions':
		case 'get_upload_albums':
		case 'get_history':
		case 'top_artists':
		case 'get_moods':
		case 'get_blocked_artists':
		case 'release_notes':
		case 'get_account_identities':
		case 'get_google_accounts':
		case 'get_active_downloads':
		case 'take_launch_args':
			return [] as unknown as T;
		case 'playlist_index':
		case 'sync_playlist_index':
		case 'get_mood_art':
		case 'set_playlist_cover':
			return {} as unknown as T;
		case 'get_settings':
			return getBrowserSettings() as unknown as T;
		case 'set_setting':
			if (args?.key && args?.value) setBrowserSetting(args.key, args.value);
			return undefined as unknown as T;
		case 'get_account':
			return { signedIn: false, canSwitch: false, selectionRequired: false } as unknown as T;
		case 'lt_get_state':
			return {
				status: 'disconnected',
				role: 'none',
				requesting: false,
				roomCode: null,
				myId: null,
				serverUrl: '',
				defaultServerUrl: '',
				users: [],
				currentTrack: null,
				queue: [],
				pendingJoins: [],
				suggestions: []
			} as unknown as T;
		case 'get_stream_clients':
			return ['browser'] as unknown as T;
		case 'listening_stats':
			return {
				secs: 0,
				prevSecs: null,
				plays: 0,
				songs: 0,
				newSongs: 0,
				artists: 0,
				days: [],
				hours: [],
				topSongs: [],
				topArtists: [],
				topAlbums: [],
				firstAt: null,
				streak: 0,
				bestStreak: 0
			} as unknown as T;
		case 'get_local_library':
			return { folders: [], albums: [], artists: [], songs: [], removed: [] } as unknown as T;
		case 'can_self_update':
		case 'global_hotkeys_on_wayland':
		case 'native_video_rect':
			return false as unknown as T;
		case 'app_icon_path':
		case 'video_stream':
		case 'comment_create':
		case 'comment_reply':
		case 'import_start':
		case 'import_status':
		case 'import_pick':
		case 'import_source':
		case 'import_update':
		case 'import_resolve':
		case 'listenbrainz_profile':
		case 'get_matugen_theme':
			return null as unknown as T;
		case 'ambient_frame':
			return new ArrayBuffer(0) as unknown as T;
		case 'get_comments':
		case 'get_comments_more':
			return { threads: [], state: 'empty', sorts: [] } as unknown as T;
		case 'get_comment_replies':
			return { replies: [] } as unknown as T;
		case 'comment_action':
			return { vote: 'neutral', actions: [] } as unknown as T;
		case 'get_playlist_more':
			return { items: [] } as unknown as T;
		case 'get_playlist_suggestions':
			return { items: [] } as unknown as T;
		case 'add_to_playlist':
			return true as unknown as T;
		case 'add_to_local_playlist':
			return [true] as unknown as T;
		case 'create_playlist':
			return 'LOCALPLAYLIST:1' as unknown as T;
		case 'get_global_hotkeys':
			return { enabled: false, bindings: {} } as unknown as T;
		case 'listenbrainz_status':
			return { connected: false } as unknown as T;
		case 'start_download':
			return 'dl-1' as unknown as T;
		case 'start_downloads_batch':
			return ['dl-1'] as unknown as T;
		case 'cancel_download':
			return true as unknown as T;
		case 'get_default_download_dir':
			return '' as unknown as T;
		case 'open_external':
			if (typeof window !== 'undefined' && args?.url) {
				window.open(args.url, '_blank');
			}
			return undefined as unknown as T;
		default:
			console.warn(`[Browser Mode Mock] Intercepted unhandled Tauri command: ${cmd}`);
			return null as unknown as T;
	}
}

/** How the signed-in user rated a track (innertube `Rating`). The three states are mutually
 *  exclusive: liking a disliked track clears the dislike, and vice versa. */
export type Rating = 'like' | 'dislike' | 'indifferent';

/** One run of an artist line: its text, plus a channel id when that run links an artist. */
export interface ArtistRun {
	text: string;
	id?: string;
}

export interface SongItem {
	video_id: string;
	title: string;
	artists: string;
	/** Primary artist's channel browseId (`UC…`), when linked — makes the artist name navigable. */
	artist_id?: string;
	/** The artist line run by run — a collab links each name to its own page. Empty/absent when
	 * nothing is linked; render plain `artists` then. */
	artist_runs?: ArtistRun[];
	album?: string;
	/** The album's browseId (`MPRE…`), when linked — makes the album navigable. */
	album_id?: string;
	duration?: string;
	/** Play count as YouTube abbreviates it ("53M"). Album, artist and search rows. */
	play_count?: string;
	thumbnail?: string;
	/** Item id within a playlist — present only on playlist tracks; needed to remove them. */
	set_video_id?: string;
	/** Collaborative playlists only: who added this track, and one avatar per person (several on a
	 * Taste Match row more than one member shares). */
	added_by?: string;
	added_by_avatars?: string[];
	/** When the track went into the playlist (unix seconds). Playlists on this machine only:
	 *  YouTube sends no such date for its own. */
	added_at?: number;
	/** The signed-in user's rating (absent when the response didn't say — same as 'indifferent'). */
	rating?: Rating;
	/** "Add to library" off the row's own menu, with a token for each direction. Absent on rows
	 *  YouTube sent no menu for, and on the ones built here (local files, On Repeat, a Listen
	 *  Together guest's queue) — the menu hides the action rather than offering a dead one.
	 *  Library ▸ Songs is not Liked Music: this is a feedback write, not a rating. */
	library?: { in_library: boolean; add_token?: string; remove_token?: string };
	/** Listen Together: name of the guest who added this queue item (session adds only). */
	queued_by?: string;
	/** Queued to play next ("Play next", or a guest's session add) — the "Next in queue" block. */
	queued?: boolean;
	/** Appended by "Add to queue" — its own block at the tail of the queue. */
	queued_end?: boolean;
	/** The album/playlist either block was added from, for its heading in the queue panel. */
	queued_from?: string;
	/** Appended by autoplay radio continuation — drives the queue's "Autoplay" divider + badge. */
	autoplay?: boolean;
	/** YouTube flags the track explicit. Browse/search rows only: `/next` carries no badge, so a
	 *  radio- or autoplay-appended track arrives without it. */
	explicit?: boolean;
	/** This row links a music video rather than the audio track. */
	is_video?: boolean;
	/** The same song's other version (its music video, or back to the audio track), when YouTube
	 *  paired them. What the player view's Song/Video switch plays (#442). */
	counterpart?: string;
	/** One of the user's own YouTube Music uploads. Set by Rust and passed straight back on play:
	 *  only an authenticated client can stream one, and the row is where that is known. */
	is_upload?: boolean;
}

export interface NowPlaying {
	videoId: string;
	title: string;
	artists: string;
	artistId?: string;
	/** The artist line run by run — links each artist of a collab separately. */
	artistRuns?: ArtistRun[];
	thumbnail?: string;
	duration?: string;
	album?: string | null;
	streamClient: string;
	/** The user's rating of the track (null if unknown). */
	rating?: Rating | null;
	/** YouTube's `musicVideoType` says this is a video upload, not the generated audio track.
	 *  Gates the player view's music-video mode. */
	isVideo?: boolean;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueState {
	items: SongItem[];
	currentIndex: number;
	shuffle?: boolean;
	repeat?: RepeatMode;
	/** What seeded the queue (playlist/album title, "<song> Radio") — the "Next from" header. */
	sourceName?: string | null;
	/** The playlist the queue was started from, when it was one. What "Remove from this playlist"
	 *  in the player's track menu writes to; absent for radios, single songs and guest queues. */
	sourceId?: string | null;
	/** Title of the track a click replaced this queue mid-play, for the panel's "Back to …" line.
	 *  Set only while `backToPrevious` would actually do something: at the head of the queue, with
	 *  a kept one behind it. */
	prevTrack?: string | null;
}

export interface Account {
	signedIn: boolean;
	name?: string | null;
	handle?: string | null;
	email?: string | null;
	thumbnail?: string | null;
	channelId?: string | null;
	canSwitch?: boolean;
	/** The cookie authenticated, but a multi-channel login is not complete until one is chosen. */
	selectionRequired?: boolean;
}

export interface AccountIdentity {
	/** Opaque, process-local selector. Raw delegated/data-sync ids stay in Rust. */
	selectionKey: string;
	name: string;
	handle?: string | null;
	email?: string | null;
	thumbnail?: string | null;
	channelId?: string | null;
	selected: boolean;
}

/** One saved Google account (multi-account). Display fields only — cookies stay in Rust. */
export interface SavedAccount {
	/** Opaque, process-local selector. */
	id: string;
	name?: string | null;
	handle?: string | null;
	email?: string | null;
	thumbnail?: string | null;
	/** The account whose session is currently driving requests. */
	active: boolean;
}

export interface BrowseItem {
	kind: 'song' | 'playlist' | 'album' | 'artist';
	/** videoId (song) or browseId (playlist/album/artist). */
	id: string;
	title: string;
	subtitle?: string;
	thumbnail?: string;
	/** "3:47" — song items from a list-style shelf only (card shelves don't carry one). */
	duration?: string;
	/** Song cards only: the track's album (`MPRE…`), what puts "Go to album" in its menus. */
	albumId?: string;
	/** Song cards only: the artist line run by run, so a card that gets played keeps its links. */
	artistRuns?: ArtistRun[];
	/** Play count as YouTube abbreviates it ("2.5B") — search song rows only. */
	playCount?: string;
	/** YouTube flags this track/album explicit. */
	explicit?: boolean;
	/** Song cards only: one of the user's own uploads. Carried into the SongItem `asSong` builds,
	 *  because that flag is what picks the login-only client chain when it plays. */
	isUpload?: boolean;
}

export interface HomeSection {
	title: string;
	/** Which of home's known sections this is (`HOME_KINDS`), in any language. Absent otherwise. */
	kind?: string;
	items: BrowseItem[];
	moreBrowseId?: string;
	moreParams?: string;
}
/** A mood/genre filter chip above the home feed; `params` re-fetches home filtered to it. */
export interface HomeChip {
	title: string;
	params: string;
}
export interface HomePage {
	chips: HomeChip[];
	sections: HomeSection[];
	continuation?: string;
}

/**
 * The On Repeat auto-playlist's synthetic browseId (mirrors `ON_REPEAT_ID` in state.rs). It routes
 * like any other playlist; the only thing the UI does differently is draw an icon cover, because
 * a playlist built from local play counts has no artwork of its own.
 */
export const ON_REPEAT_ID = 'KANADE_ON_REPEAT';

/**
 * Liked Music's browseId. YouTube edits this one through the rating endpoint, not `edit_playlist`,
 * so it is never an add/remove/rename target: liking the song is the edit.
 */
export const LIKED_MUSIC_ID = 'VLLM';

/**
 * YouTube Music's own Library ▸ Songs, despite the name: the songs saved to the account's library.
 * It browses like a playlist (no header, no sort menu), so `getPlaylist` reads it and the Library
 * page's Songs tab pages through it with `getPlaylistMore`.
 */
export const LIBRARY_SONGS_ID = 'FEmusic_liked_videos';

/**
 * The tracks the signed-in user uploaded to YouTube Music themselves. Browses like the songs grid
 * above, so the same tab component reads it; the rows come back with `is_upload` set, which is what
 * sends them down the login-only fallback chain when they play (issue #71).
 */
export const LIBRARY_UPLOADS_ID = 'FEmusic_library_privately_owned_tracks';

/**
 * Local music (Rust `local.rs`). A file on disk is a song whose `video_id` is `LOCAL:<path>`, and
 * an album of them is a browseId `LOCALALBUM:<key>` — so local items ride every existing surface
 * (cards, queue, Shortcuts, the album page) and play with no network.
 */
export const LOCAL_SONG_PREFIX = 'LOCAL:';
export const LOCAL_ALBUM_PREFIX = 'LOCALALBUM:';
/** An artist on this disk. Renders through the album route: same page, no YouTube channel. */
export const LOCAL_ARTIST_PREFIX = 'LOCALARTIST:';
/**
 * A playlist kept on this machine, no account needed (#251; mirrors `LOCAL_PLAYLIST_PREFIX` in
 * state.rs). The playlist commands answer it from SQLite, so it rides the same route and the same
 * calls as a YouTube playlist, and can hold local files as well as YouTube tracks.
 */
export const LOCAL_PLAYLIST_PREFIX = 'LOCALPLAYLIST:';
export const isLocalPlaylist = (id: string | undefined | null): boolean =>
	!!id && id.startsWith(LOCAL_PLAYLIST_PREFIX);
/** Anything with no YouTube item behind it: nothing to share, no radio, no account to save it to. */
export const isLocalId = (id: string | undefined | null): boolean =>
	!!id &&
	(id.startsWith(LOCAL_SONG_PREFIX) ||
		id.startsWith(LOCAL_ALBUM_PREFIX) ||
		id.startsWith(LOCAL_ARTIST_PREFIX) ||
		id.startsWith(LOCAL_PLAYLIST_PREFIX));

export interface LocalLibrary {
	/** Watched folders, as absolute paths. */
	folders: string[];
	albums: BrowseItem[];
	artists: BrowseItem[];
	songs: SongItem[];
	/** Song/album/artist ids that were in the library but are gone from disk since the last scan. */
	removed: string[];
}

/** The orders YouTube itself can put a playlist in — everything in `SortKey` but our own `plays`. */
export type ServerSort = 'default' | 'newest' | 'oldest' | 'title' | 'artist' | 'album' | 'top';

export interface SortMenu {
	/** The order YouTube has this list in right now, when it is one we have a name for. */
	selected?: ServerSort;
	/**
	 * The choice is a write, so storing it makes YouTube Music and every other client follow.
	 * Playlists you own only: elsewhere the menu is view-only (Liked Music remembers the last order
	 * asked for anyway, someone else's playlist does not).
	 */
	editable: boolean;
}

/** One day bucket of the play history: YouTube's own heading plus that day's rows. */
export interface HistoryGroup {
	title: string;
	items: SongItem[];
}

export interface PlaylistPage {
	title?: string;
	subtitle?: string;
	thumbnail?: string;
	/** The playlist's own blurb, which the edit dialog prefills its description with. */
	description?: string;
	/** `PUBLIC` / `PRIVATE` / `UNLISTED`. Only playlists you own report it. */
	privacy?: string;
	/** Custom artwork picked on this machine; falls back to `thumbnail` when unset. */
	cover?: string;
	items: SongItem[];
	continuation?: string;
	/** True only when the signed-in user owns this playlist (rename/delete allowed). */
	owned: boolean;
	/** Collaboration is on: others can add to it, and each person may remove only what they added. */
	collaborative: boolean;
	/** Absent on lists YouTube will not reorder: albums, its own radio mixes, On Repeat. */
	sortMenu?: SortMenu;
	/** YouTube's own suggestions shelf (`getPlaylistSuggestions`), on playlists you own under 100
	 *  tracks. The rest get suggestions all the same, from the playlist's radio. */
	suggestions?: string;
}
export interface PlaylistContinuation {
	items: SongItem[];
	continuation?: string;
}
/** One batch of suggestions; `refresh` swaps it for a fresh one. */
export interface PlaylistSuggestions {
	items: SongItem[];
	refresh?: string;
}

export interface ArtistCarousel {
	title: string;
	items: BrowseItem[];
	moreBrowseId?: string;
	moreParams?: string;
}
export interface SearchResults {
	top: BrowseItem[];
	songs: BrowseItem[];
	albums: BrowseItem[];
	artists: BrowseItem[];
	playlists: BrowseItem[];
}

/** Typeahead under a search field: query completions, then a few matching rows. */
export interface SearchSuggestions {
	queries: { text: string; /** One of the account's own past searches. */ history: boolean }[];
	items: BrowseItem[];
}

export interface AlbumPage {
	title?: string;
	artist?: string;
	artistId?: string;
	/** The artist line run by run — links each artist of a collaborative album separately. */
	artistRuns?: ArtistRun[];
	artistThumbnail?: string;
	subtitle?: string;
	secondSubtitle?: string;
	description?: string;
	thumbnail?: string;
	items: SongItem[];
	continuation?: string;
	/** The album itself is flagged explicit (the header wears the badge, not just some tracks). */
	explicit?: boolean;
	/** The album's audio playlist id (`OLAK5uy_…`) — autoplay's radio seed, and the save target. */
	playlistId?: string;
	/** Already saved to the signed-in user's library. */
	inLibrary: boolean;
	/** Card shelves under the tracks: other versions, more from the artist, related releases. */
	sections?: ArtistCarousel[];
}

export interface ArtistPage {
	name?: string;
	/** Wide hero/banner image from the page header. */
	thumbnail?: string;
	/** Round channel avatar. Only channels YouTube Music doesn't treat as artists have one. */
	avatar?: string;
	description?: string;
	subscribers?: string;
	monthlyListeners?: string;
	channelId: string;
	subscribed: boolean;
	topSongs: SongItem[];
	/** `VL…` playlist of all the artist's top songs, behind the shelf's "See all". */
	topSongsId?: string;
	sections: ArtistCarousel[];
}

// --- commands (context/11) -----------------------------------------------------------------
// `recordHistory` is true only for a query the user submitted: a signed-in search is written to the
// account's YouTube search history, so a typeahead preview must stay anonymous (#203).
export const search = (query: string, recordHistory = false) =>
	invoke<SongItem[]>('search', { query, recordHistory });
/** Video uploads only: covers, live sets and remixes with no official release. Empty when the
 *  "hide music videos" setting is on. */
export const searchVideos = (query: string) => invoke<SongItem[]>('search_videos', { query });
/** One song or video by id, title and art included (a pasted YouTube link). */
export const song = (videoId: string) => invoke<SongItem>('song', { videoId });
/** Unfiltered search → categorized sections. */
export const searchAll = (query: string, recordHistory = false) =>
	invoke<SearchResults>('search_all', { query, recordHistory });
/** The typeahead. Signed in, yet never written to search history: it's the request YTM's own
 *  search box sends on every keystroke. */
export const searchSuggestions = (query: string) =>
	invoke<SearchSuggestions>('search_suggestions', { query });
/** Filtered "Show more" card search for one category (albums / artists / playlists). */
export const searchCards = (query: string, category: 'albums' | 'artists' | 'playlists') =>
	invoke<BrowseItem[]>('search_cards', { query, category });
export const play = (item: SongItem) => invoke<void>('play', { item });
export const playIndex = (index: number) => invoke<void>('play_index', { index });
/** Play the current track's `counterpart` from the same position. Resolves once it plays. */
export const switchVersion = () => invoke<void>('switch_version');
/** Remove an upcoming track from the queue (host/local only — guests are add-only). */
export const removeFromQueue = (index: number) => invoke<void>('remove_from_queue', { index });
/** Drag-to-reorder: move the upcoming queue item at `from` to index `to` (both past the playing
 * track — the history and the playing row don't move). */
export const moveInQueue = (from: number, to: number) =>
	invoke<void>('move_in_queue', { from, to });
/**
 * "Play next": insert tracks right behind the playing one, behind any earlier "Play next" adds.
 * `from` is the album/playlist they came from.
 */
export const playNext = (items: SongItem[], from?: string) =>
	invoke<void>('play_next', { items, from });
/**
 * "Add to queue": the tracks go at the tail of the queue, behind the rest of the playing album or
 * playlist and anything added before, ahead of autoplay (#369). On a radio they go ahead of the
 * generated tracks instead. `continuation` is the source page's next-page token: the backend walks
 * the rest of a long playlist into the queue in the background.
 */
export const addToQueue = (items: SongItem[], from?: string, continuation?: string) =>
	invoke<void>('add_to_queue', { items, from, continuation });
/** Clear every upcoming track added by hand, with Play next or Add to queue. */
export const clearQueued = () => invoke<void>('clear_queued');
export const nextTrack = () => invoke<void>('next_track');
export const prevTrack = () => invoke<void>('prev_track');
/** Put back the queue a click replaced, at the track and position it was left at. Previous does
 *  this too, but only from the top of a track. */
export const backToPrevious = () => invoke<void>('back_to_previous');
export const toggleShuffle = () => invoke<void>('toggle_shuffle');
export const setRepeat = (mode: RepeatMode) => invoke<void>('set_repeat', { mode });
export const togglePause = () => invoke<void>('toggle_pause');
export const seek = (position: number) => invoke<void>('seek', { position });
export const setVolume = (volume: number) => invoke<void>('set_volume', { volume });
/** Tempo (0.25–2.0) + pitch (−12..=12 semitones). Not persisted: resets on restart. */
export const setPlaybackParams = (speed: number, semitones: number) =>
	invoke<void>('set_playback_params', { speed, semitones });
export const getQueue = () => invoke<QueueState>('get_queue');
/** A `kanadevideo://` URL for the track's music video, or null when there isn't one. `maxHeight`
 *  caps the picture at what the box on screen can actually show. The bytes are proxied through
 *  Rust; the webview never sees a googlevideo URL. */
export const videoStream = (videoId: string, maxHeight: number) =>
	invoke<string | null>('video_stream', { videoId, maxHeight });

/** Drop the backend's memory of this track's video URL, after the element failed to load it. */
export const forgetVideoStream = (videoId: string) =>
	invoke<void>('forget_video_stream', { videoId });

/** Linux and Windows: where the page's hole for the music video is (`[x, y, w, h]`, CSS pixels,
 *  relative to the viewport), or null when there is none. mpv draws the picture there, under the
 *  webview. Resolves whether the picture is up; `false` for a rect means it never will be (no
 *  surface), so fall back to the `<video>` element. `dpr` carries the page zoom to Windows. */
export const nativeVideoRect = (rect: [number, number, number, number] | null) =>
	invoke<boolean>('native_video_rect', { rect, dpr: devicePixelRatio });

/** Linux and Windows: the newest small frame of mpv's picture other than `after`, for the ambient
 *  light, as `[seq, w, h]` little-endian u32s and then RGBA rows bottom-up. Empty when there is no
 *  new one (Linux waits a quarter second for it). Asking is also what keeps Rust grabbing them
 *  (nativevideo.rs; on Windows each ask is one grab, nativevideo_windows.rs).
 *  An ArrayBuffer, except once Tauri has fallen back from its custom protocol to postMessage (it
 *  does for the rest of the page's life after any IPC fetch fails): raw bytes then arrive as a
 *  plain array of numbers. */
export const ambientFrame = (after: number) =>
	invoke<ArrayBuffer | number[]>('ambient_frame', { after });

/** What the event stream already reported, for a webview that started after it did. */
export interface PlaybackSnapshot {
	now: NowPlaying | null;
	paused: boolean;
	position: number;
	duration: number;
	/** The level restored from last run (or the one another window already set). */
	volume: number;
}
export const getPlayback = () => invoke<PlaybackSnapshot>('get_playback');

// --- settings (context/11) -----------------------------------------------------------------
export const getSettings = () => invoke<Record<string, string>>('get_settings');
export const setSetting = (key: string, value: string) =>
	invoke<void>('set_setting', { key, value });
/** Streamable client keys for the "disabled clients" setting. */
export const getStreamClients = () => invoke<string[]>('get_stream_clients');
/** Wipe both cache tiers (URL cache + mpv on-disk audio cache). */
export const clearCaches = () => invoke<void>('clear_caches');
/** Set the app icon to a PNG the user picked, or restore the bundled one with `null` (#173). */
export const setAppIcon = (path: string | null) => invoke<void>('set_app_icon', { path });
/** Path to the custom app icon, granted to the asset protocol. `null` when the bundled one is in use. */
export const appIconPath = () => invoke<string | null>('app_icon_path');

/** Grant the webview a URL for one font file the user picked, so `@font-face` can load it. */
export const allowFontFile = (path: string) => invoke<void>('allow_font_file', { path });

// --- global hotkeys -------------------------------------------------------------------------
export interface HotkeysConfig {
	enabled: boolean;
	bindings: Record<string, string>;
}

export interface HotkeyRegisterResult {
	success: boolean;
	config: HotkeysConfig;
	errors: Record<string, string>;
}

export const getGlobalHotkeys = () => invoke<HotkeysConfig>('get_global_hotkeys');
export const globalHotkeysOnWayland = () => invoke<boolean>('global_hotkeys_on_wayland');
export const setGlobalHotkeys = (config: HotkeysConfig) =>
	invoke<HotkeyRegisterResult>('set_global_hotkeys', { config });
export const resetGlobalHotkeys = () => invoke<HotkeyRegisterResult>('reset_global_hotkeys');

/** One published release: the GitHub release description, verbatim markdown. */
export interface ReleaseNote {
	version: string;
	/** `YYYY-MM-DD` */
	date: string;
	body: string;
}
/** Changelog for Settings > About, from the GitHub releases API (cached in Rust per run). */
export const releaseNotes = () => invoke<ReleaseNote[]>('release_notes');
/** True when the build can self-update in place (AppImage on Linux, or Windows/macOS). */
export const canSelfUpdate = () => invoke<boolean>('can_self_update');
/** Open an http(s) link in the real browser, never in the webview itself. */
export const openExternal = (url: string) => invoke<void>('open_external', { url });
/** Real quit (not close-to-tray). Same path as the tray's Quit item. */
export const quitApp = () => invoke<void>('quit_app');

/** Environment + the redacted tail of `kanade.log`, for pasting into a bug report. */
export const diagnostics = () => invoke<string>('diagnostics');
/** Just the environment block, for prefilling the GitHub bug form. */
export const diagnosticsSummary = () => invoke<string>('diagnostics_summary');
/** The same text, written to a path the user picked in a save dialog. */
export const saveDiagnostics = (path: string) => invoke<void>('save_diagnostics', { path });

// --- auth (context/15) ---------------------------------------------------------------------
export const getAccount = () => invoke<Account>('get_account');
export const getAccountIdentities = () =>
	invoke<AccountIdentity[]>('get_account_identities');
export const switchAccount = (selectionKey: string) =>
	invoke<Account>('switch_account', { selectionKey });
export const signOut = () => invoke<void>('sign_out');
/**
 * Open the in-app Google sign-in webview (context/15 Path A). Result arrives via onAuthChanged.
 * With `addAccount`, Google's AddSession screen is used so a second account can be added even
 * while the webview already holds a Google session.
 */
export const loginWebview = (addAccount = false) => invoke<void>('login_webview', { addAccount });
/** Saved Google accounts for the account menu (display fields only). */
export const getGoogleAccounts = () => invoke<SavedAccount[]>('get_google_accounts');
/** Activate a saved account without a Google re-login. Fails if its stored session expired. */
export const switchGoogleAccount = (id: string) =>
	invoke<Account>('switch_google_account', { id });
/** Delete a saved account; removing the active one signs out. */
export const removeGoogleAccount = (id: string) => invoke<void>('remove_google_account', { id });

// --- mini player (Rust mini.rs) ---------------------------------------------------------------
/** Hide the app to the tray and open the floating widget (a second window running this same SPA). */
export const openMini = () => invoke<void>('open_mini');
/** Close the widget and bring the app back. */
export const closeMini = () => invoke<void>('close_mini');
/** Shrink the widget to its compact size, or back (#301). Remembered for the next open. */
export const setMiniCompact = (compact: boolean) => invoke<void>('set_mini_compact', { compact });

// --- browse / library (context/08) ---------------------------------------------------------
/** `params` is a `HomeChip.params` token — omit for the unfiltered feed. */
export const getHome = (params?: string) => invoke<HomePage>('get_home', { params });
export const getHomeMore = (token: string) => invoke<HomePage>('get_home_more', { token });

/** A comment's author. `channel_id` and `avatar` are absent when YouTube omitted them. */
export interface CommentAuthor {
	name: string;
	channel_id?: string;
	avatar?: string;
	verified: boolean;
	is_creator: boolean;
	is_artist: boolean;
}

/** One comment. Counts and the time are YouTube's own display strings ("2.4M", "6 years ago"),
 *  shown as they come: they are not numbers and not in the app's language. */
export interface Comment {
	id: string;
	text: string;
	author: CommentAuthor;
	published?: string;
	/** The count as it reads for the viewer's current vote. */
	like_count?: string;
	/** The count if the viewer has not liked it / has. Swap between these, never add to one. */
	like_count_notliked?: string;
	like_count_liked?: string;
	/** The viewer's vote; absent when read anonymously. */
	vote?: CommentVote;
	/** What the viewer can do to this comment now; the vote buttons go by this alone. */
	actions: CommentAction[];
	reply_count?: string;
	hearted: boolean;
	pinned: boolean;
	/** The viewer's own comment. */
	own: boolean;
	/** What the edit dialog pre-fills, when the response had it plainly; edit `text` otherwise. */
	edit_text?: string;
	/** What the viewer can write on it, as the response offered. Empty signed out. */
	writes: CommentWrite[];
	/** The reply box's placeholder, if the response sent one. */
	reply_placeholder?: string;
}

export type CommentWrite = 'reply' | 'edit' | 'delete';

export type CommentVote = 'neutral' | 'liked' | 'disliked';
export type CommentAction = 'like' | 'unlike' | 'dislike' | 'undislike';

export interface CommentThread {
	comment: Comment;
	/** Loads this thread's replies (`getCommentReplies`); absent when there is nothing to fetch. */
	replies_token?: string;
	/** Replies that arrived with the thread, nested levels already flattened. */
	replies: Comment[];
}

export interface CommentSort {
	key: 'top' | 'newest';
	selected: boolean;
	/** Pass to `getCommentsMore` to reload the comments in this order. */
	token: string;
}

export interface CommentsHeader {
	/** The short count ("7.8K"). */
	count_text?: string;
	sorts: CommentSort[];
	/** The comment box. Present only when the response carried a way to post (signed in). */
	composer?: { placeholder?: string };
}

/** `disabled` covers both "turned off" and "could not be read": either way, nothing to show. */
export type CommentsState = 'ok' | 'empty' | 'disabled';

export interface CommentsPage {
	/** First page and sort switches only. */
	header?: CommentsHeader;
	threads: CommentThread[];
	/** Next page of top-level comments; absent is the end of the list. */
	continuation?: string;
	state: CommentsState;
}

export interface CommentReplies {
	replies: Comment[];
	continuation?: string;
}

/** What a comment looks like after YouTube accepted an action on it. */
export interface CommentActionOutcome {
	vote: CommentVote;
	actions: CommentAction[];
}

/** Why a comments command failed: `CommentsError` in `src-tauri/src/commands.rs`. */
const COMMENTS_ERROR_KINDS = ['account_changed', 'busy', 'rejected', 'gone', 'uncertain', 'failed'] as const;
export type CommentsErrorKind = (typeof COMMENTS_ERROR_KINDS)[number];

/** The kind out of whatever a comments command rejected with; anything unrecognised is `failed`. */
export const commentsErrorKind = (e: unknown): CommentsErrorKind =>
	typeof e === 'string' && (COMMENTS_ERROR_KINDS as readonly string[]).includes(e)
		? (e as CommentsErrorKind)
		: 'failed';

export const getComments = (videoId: string) => invoke<CommentsPage>('get_comments', { videoId });
/** The next page of comments, or the same comments in another order (a sort token). */
export const getCommentsMore = (token: string) =>
	invoke<CommentsPage>('get_comments_more', { token });
export const getCommentReplies = (token: string) =>
	invoke<CommentReplies>('get_comment_replies', { token });
/** Like, unlike, dislike or undislike one comment; only an action in its `actions`. */
export const commentAction = (commentId: string, action: CommentAction) =>
	invoke<CommentActionOutcome>('comment_action', { commentId, action });
/** Post a top-level comment on `videoId`, the track whose comments are shown (needs the header's
 *  `composer`; refused if it was read for another track). Resolves with the posted comment when
 *  YouTube's answer carried it, otherwise `null`. */
export const commentCreate = (videoId: string, text: string) =>
	invoke<CommentThread | null>('comment_create', { videoId, text });
/** Reply to a comment that offers `reply`. Resolves with the reply as for `commentCreate`. */
export const commentReply = (commentId: string, text: string) =>
	invoke<Comment | null>('comment_reply', { commentId, text });
/** Replace the text of one of the viewer's own comments (one that offers `edit`). */
export const commentEdit = (commentId: string, text: string) =>
	invoke<void>('comment_edit', { commentId, text });
/** Delete one of the viewer's own comments (one that offers `delete`). */
export const commentDelete = (commentId: string) => invoke<void>('comment_delete', { commentId });
/**
 * On Repeat is the app's own playlist (Rust builds it from this machine's play counts), so its
 * title and subtitle are our English rather than YouTube's, and Rust cannot translate them: the
 * UI language lives in the webview's localStorage and never reaches it. Relabelled here, on the
 * way in, because every surface that draws the tile reads it from one of these two calls.
 */
const relabelOnRepeat = (item: BrowseItem): BrowseItem =>
	item.id !== ON_REPEAT_ID
		? item
		: {
			...item,
			title: t('library.on_repeat'),
			// The count is Rust's leading number ("20 songs"); left alone if it ever isn't.
			subtitle: Number.isNaN(parseInt(item.subtitle ?? '', 10))
				? item.subtitle
				: t('library.songs_count', { count: parseInt(item.subtitle!, 10) })
		};

/** Same reason as On Repeat: Rust's "12 songs" on a playlist kept on this machine. */
const relabelLocal = (item: BrowseItem): BrowseItem => {
	if (!isLocalPlaylist(item.id)) return relabelOnRepeat(item);
	const count = parseInt(item.subtitle ?? '', 10);
	if (Number.isNaN(count)) return item;
	return {
		...item,
		subtitle:
			count === 1
				? t('library.local_playlist_subtitle_one')
				: t('library.local_playlist_subtitle', { count })
	};
};

/** Every playlist in the library: On Repeat, the ones on this machine, then the account's. */
export const getLibrary = () =>
	invoke<BrowseItem[]>('get_library').then((items) => items.map(relabelLocal));
/** Just the playlists on this machine. SQLite only, so it answers offline and signed out. */
export const getLocalPlaylists = () =>
	invoke<BrowseItem[]>('local_playlists').then((items) => items.map(relabelLocal));
export const getLibraryAlbums = () => invoke<BrowseItem[]>('get_library_albums');
export const getLibraryArtists = () => invoke<BrowseItem[]>('get_library_artists');
/** Library ▸ Artists ▸ Subscriptions: the channels the account subscribes to. */
export const getLibrarySubscriptions = () => invoke<BrowseItem[]>('get_library_subscriptions');
export const getUploadAlbums = () => invoke<BrowseItem[]>('get_upload_albums');
/**
 * The account's YouTube Music play history, in YouTube's own day buckets (Today, Yesterday, …).
 * Empty when signed out.
 */
export const getHistory = () => invoke<HistoryGroup[]>('get_history');
/**
 * `sort` asks YouTube to order the tracks; omit it to get whatever order the account already has
 * the list in, which is the one a fresh visit wants (it is what YouTube Music would show).
 */
export const getPlaylist = (id: string, sort?: ServerSort, desc?: boolean) =>
	invoke<PlaylistPage>('get_playlist', { id, sort, desc }).then((page) =>
		id !== ON_REPEAT_ID
			? page
			: {
				...page,
				title: t('library.on_repeat'),
				subtitle: t('library.on_repeat_subtitle', { count: page.items.length })
			}
	);
/**
 * Store a sort order on a playlist, so YouTube Music and every other client show it the same way.
 * Only for a list whose `sortMenu.editable` is true.
 */
export const setPlaylistSort = (playlistId: string, sort: ServerSort) =>
	invoke<void>('set_playlist_sort', { playlistId, sort });
export const getPlaylistMore = (token: string) =>
	invoke<PlaylistContinuation>('get_playlist_more', { token });
/** `token` is `PlaylistPage.suggestions`, the last batch's `refresh`, or nothing at all. */
export const getPlaylistSuggestions = (playlistId: string, token?: string) =>
	invoke<PlaylistSuggestions>('get_playlist_suggestions', { playlistId, token });
/**
 * videoId → the ids of the playlists you own that hold it. Read straight from local SQLite, so it
 * answers instantly and is empty until `syncPlaylistIndex` has filled it in at least once.
 */
export const playlistIndex = () => invoke<Record<string, string[]>>('playlist_index');
/**
 * Re-walk your own playlists and answer with the rebuilt map. Skips the crawl while the stored one
 * is still inside its window, so calling this on every launch is cheap.
 */
export const syncPlaylistIndex = () => invoke<Record<string, string[]>>('sync_playlist_index');
/**
 * videoId → times played, from the local listening history, over the trailing window On Repeat uses
 * (a month). A videoId that isn't in the map has not been played inside the window.
 */
export const getPlayCounts = () => invoke<Record<string, number>>('play_counts');

/** The stats page's lists (#396): times played and seconds heard, inside the window. */
export interface TopSong {
	song: SongItem;
	plays: number;
	secs: number;
}
export interface TopArtist {
	name: string;
	/** Their channel (`UC…`) or a local artist (`LOCALARTIST:…`); null when the credit links none. */
	id: string | null;
	/** The cover of their most-heard song, for when there's no photo. */
	thumbnail: string | null;
	plays: number;
	secs: number;
}
export interface TopAlbum {
	id: string;
	title: string;
	artist: string;
	thumbnail: string | null;
	plays: number;
	secs: number;
}
/** Everything the stats page shows for one window, counted on this device. */
export interface ListeningStats {
	secs: number;
	/** Seconds in the window of the same length just before this one; null for all time. */
	prevSecs: number | null;
	plays: number;
	songs: number;
	/** Songs played for the first time ever inside the window. */
	newSongs: number;
	artists: number;
	/** Seconds per local day (`2026-10-17`), oldest first, days with nothing left out. */
	days: [string, number][];
	/** Seconds per local weekday (0 = Sunday) and hour: `hours[day * 24 + hour]`. */
	hours: number[];
	topSongs: TopSong[];
	topArtists: TopArtist[];
	topAlbums: TopAlbum[];
	/** Unix secs of the oldest play on record; null when nothing has been counted yet. */
	firstAt: number | null;
	/** Days in a row with a play, up to today, and the longest run ever. Whole history. */
	streak: number;
	bestStreak: number;
}
/** `since`: unix secs where the window starts, 0 for all time. It always ends now. */
export const listeningStats = (since: number) =>
	invoke<ListeningStats>('listening_stats', { since });
/** The `limit` most played artists of all time, on the stats page's counts. Home's Familiar Artists. */
export const topArtists = (limit: number) => invoke<TopArtist[]>('top_artists', { limit });
/** Forget every counted play. On Repeat empties with it. */
export const clearListeningHistory = () => invoke<void>('clear_listening_history');
/**
 * `start`: the clicked track index, or `null` for "just play it" (random opener under shuffle).
 * `sourceId`: the page's playlist/album playlist id — makes autoplay continue with that
 * context's radio (omit to fall back to song radio seeded from the queue's last track).
 * `sourceName`: the page title, for the queue panel's "Next from" header.
 * `shuffle`: turn shuffle on for this queue — pass items in their real order, Rust shuffles.
 */
export const playPlaylist = (
	items: SongItem[],
	start: number | null,
	sourceId?: string,
	sourceName?: string,
	shuffle?: boolean,
	continuation?: string
) => invoke<void>('play_playlist', { items, start, sourceId, sourceName, shuffle, continuation });
/**
 * Start a radio: an endless YouTube-generated queue seeded on this item. `id` is the videoId
 * (song) or browseId/playlistId (everything else) — Rust resolves it to a radio playlist, so the
 * UI never builds one. `name` titles the queue ("<name> Radio").
 *
 * A song radio on the track that's already playing splices in behind it (no re-buffer); every
 * other case replaces the queue. Rejects when YouTube has no radio for the item.
 */
export const startRadio = (kind: 'song' | 'artist' | 'album' | 'playlist', id: string, name?: string) =>
	invoke<void>('start_radio', { kind, id, name });
export const getAlbum = (id: string) => invoke<AlbumPage>('get_album', { id });
export const getArtist = (id: string) => invoke<ArtistPage>('get_artist', { id });
/** Other artists' releases this one is featured on (#456). `songsId` is the page's `topSongsId`. */
export const getArtistAppearsOn = (id: string, songsId: string) =>
	invoke<BrowseItem[]>('get_artist_appears_on', { id, songsId });
/** A Moods & Genres tile. `params` browses `MOODS_CATEGORY_ID` into that mood's playlists. */
export interface Mood {
	title: string;
	params: string;
	/** YouTube's own colour for the tile, `#rrggbb`. */
	color: string;
}
export interface MoodSection {
	title: string;
	items: Mood[];
}
export const MOODS_CATEGORY_ID = 'FEmusic_moods_and_genres_category';
export const getMoods = () => invoke<MoodSection[]>('get_moods');
/** A cover per tile (the first playlist in its category), keyed by the tile's `params`. */
export const getMoodArt = (params: string[]) =>
	invoke<Record<string, string>>('get_mood_art', { params });
export const getBrowseGrid = (id: string, params?: string) =>
	invoke<BrowseItem[]>('get_browse_grid', { id, params });

// --- local music (local.rs) ------------------------------------------------------------------
/** Rescan the watched folders. Cheap when nothing changed (one stat per file). */
export const getLocalLibrary = () => invoke<LocalLibrary>('get_local_library');
export const addLocalFolder = (path: string) => invoke<LocalLibrary>('add_local_folder', { path });
export const removeLocalFolder = (path: string) =>
	invoke<LocalLibrary>('remove_local_folder', { path });

// --- blocked artists (blocked.rs, plan 046) ---------------------------------------------------
/** One entry in the block list. `id` is the channel browseId when the blocked row linked one. */
export interface BlockedArtist {
	id?: string;
	name: string;
}
export const getBlockedArtists = () => invoke<BlockedArtist[]>('get_blocked_artists');
/** Blocks the artist and returns the new list. Rust also drops them out of the live queue. */
export const blockArtist = (id: string | undefined, name: string) =>
	invoke<BlockedArtist[]>('block_artist', { id, name });
/** `key` is the entry's channel id when it has one, else its name. */
export const unblockArtist = (key: string) => invoke<BlockedArtist[]>('unblock_artist', { key });

// --- write actions (context/01 ✎) ----------------------------------------------------------
/** Like, dislike, or clear the rating. YouTube's three states are mutually exclusive, so a dislike
 *  un-likes in the same call. */
export const rate = (videoId: string, rating: Rating) => invoke<void>('rate', { videoId, rating });
/** `false` = the playlist already had this track, so YouTube added nothing. */
export const addToPlaylist = (playlistId: string, videoId: string, allowDuplicates = false) =>
	invoke<boolean>('add_to_playlist', { playlistId, videoId, allowDuplicates });
export const removeFromPlaylist = (playlistId: string, videoId: string, setVideoId: string) =>
	invoke<void>('remove_from_playlist', { playlistId, videoId, setVideoId });

/** Bulk removal: one request, all or nothing. `tracks` is [videoId, setVideoId] per row. */
export const removeManyFromPlaylist = (playlistId: string, tracks: [string, string][]) =>
	invoke<void>('remove_many_from_playlist', { playlistId, tracks });
/** `local` keeps it on this machine instead of the account, the only kind there is signed out.
 *  Answers the new id: a `LOCALPLAYLIST:` browseId for a local one, YouTube's playlist id else. */
export const createPlaylist = (title: string, local = false) =>
	invoke<string>('create_playlist', { title, local });
/** Add whole songs to a playlist on this machine, in one write. Answers per song whether it went
 *  in: `false` means the playlist already had it. Local files are fine here. */
export const addToLocalPlaylist = (playlistId: string, items: SongItem[]) =>
	invoke<boolean[]>('add_to_local_playlist', { playlistId, items });
/** Name / description / visibility, from the "Edit playlist" dialog. Leave a field out and
 *  YouTube is never told about it, so an untouched one can't be overwritten. */
export const editPlaylistDetails = (
	playlistId: string,
	changes: { name?: string; description?: string; public?: boolean }
) => invoke<void>('edit_playlist_details', { playlistId, ...changes });
/** Custom playlist artwork. `path` is a file the user picked; `null` drops it. Answers where the
 *  local copy went, and on a removal the thumbnail YouTube rebuilt from the tracks (that one is
 *  worth waiting for: YouTube's own thumbnail is the cover being removed until it lands). */
export const setPlaylistCover = (playlistId: string, path: string | null) =>
	invoke<{ cover?: string; thumbnail?: string }>('set_playlist_cover', { playlistId, path });
export const deletePlaylist = (playlistId: string) =>
	invoke<void>('delete_playlist', { playlistId });
export const subscribe = (channelId: string, subscribed: boolean) =>
	invoke<void>('subscribe', { channelId, subscribed });
/** Add a song to Library ▸ Songs, or take it out. `token` is `SongItem.library.add_token` /
 *  `.remove_token`; YouTube mints them per row, so they come from the list the song was shown in. */
export const setSongSaved = (token: string) => invoke<void>('set_song_saved', { token });
/** Save an album to the library (or remove it). `playlistId` is `AlbumPage.playlistId`. */
export const setAlbumSaved = (playlistId: string, saved: boolean) =>
	invoke<void>('set_album_saved', { playlistId, saved });

// --- Spotify import (spotify.rs, import.rs, #375) ----------------------------------------------
// Rejections are short codes (`private`, `busy`, ...) worded by `importError` in import.svelte.ts.

export type ImportTier = 'pending' | 'matched' | 'check' | 'missing';
export type ImportPhase = 'matching' | 'review' | 'creating' | 'done' | 'failed' | 'cancelled';
/** `liked` is Liked Songs, named in the user's language on this side. */
export type ImportListKind = 'playlist' | 'album' | 'liked';

export interface ImportListPreview {
	kind: ImportListKind;
	name: string;
	owner?: string | null;
	cover?: string | null;
	count: number;
	/** Rows that aren't songs (podcast episodes), left out. */
	skipped: number;
	/** Spotify only let the first 100 tracks be read. */
	truncated: boolean;
}
export interface ImportPreview {
	lists: ImportListPreview[];
}
export interface ImportResult {
	kind: ImportListKind;
	name: string;
	/** The browse id to open: `VL…`, or `LOCALPLAYLIST:<n>` on this device. */
	id: string;
	local: boolean;
	added: number;
	missing: number;
	removed: number;
}
export interface ImportSnapshot {
	phase: ImportPhase;
	/** Distinct tracks across every list being imported. */
	total: number;
	done: number;
	matched: number;
	check: number;
	missing: number;
	lists: { kind: ImportListKind; name: string; count: number; cover?: string | null }[];
	/** The last few tracks matched, newest first. */
	recent: { title: string; artists: string; tier: ImportTier; thumbnail?: string | null }[];
	/** While creating: steps done, steps in all. */
	step: [number, number];
	/** Pausing to stay within the hourly search budget: the unix second it goes on. */
	waitingUntil?: number | null;
	message?: string | null;
	results: ImportResult[];
	/** Set when this is an "Update from Spotify" of that playlist rather than an import. */
	update?: string | null;
}
export interface ImportRow {
	key: string;
	title: string;
	artists: string;
	album?: string | null;
	durationMs?: number | null;
	tier: ImportTier;
	pick?: SongItem | null;
	/** Empty for matched rows. */
	candidates: SongItem[];
}
export type ImportResolved =
	| { kind: 'song'; song: SongItem }
	| { kind: 'album'; id: string }
	| { kind: 'artist'; id: string }
	| { kind: 'playlist' };

export const importReadLink = (link: string) => invoke<ImportPreview>('import_read', { link });
export const importReadPath = (path: string) => invoke<ImportPreview>('import_read', { path });
/** A dropped file: the bytes go over as the raw request body (a webview drop has no path). */
export const importReadFile = async (file: File) =>
	invoke<ImportPreview>('import_read_file', new Uint8Array(await file.arrayBuffer()), {
		headers: { 'x-file-name': encodeURIComponent(file.name) }
	});
/** `lists` are indices into the last preview. */
export const importStart = (lists: number[]) => invoke<ImportSnapshot>('import_start', { lists });
export const importStatus = () => invoke<ImportSnapshot | null>('import_status');
export const importRows = (tier: ImportTier) => invoke<ImportRow[]>('import_rows', { tier });
/** `null` leaves the track out. A song picked here is remembered for every later import. */
export const importPick = (key: string, song: SongItem | null) =>
	invoke<ImportSnapshot>('import_pick', { key, song });
export const importCreate = (options: { names?: Record<number, string>; local?: boolean }) =>
	invoke<void>('import_create', { options });
/** Stops a running import, or puts away a finished one. */
export const importCancel = () => invoke<void>('import_cancel');
export const importSource = (playlistId: string) =>
	invoke<string | null>('import_source', { playlistId });
export const importUpdate = (playlistId: string) =>
	invoke<ImportSnapshot>('import_update', { playlistId });
export const importResolve = (link: string) => invoke<ImportResolved>('import_resolve', { link });

// --- events (context/11). Each returns an unlisten fn; call it on component teardown. --------
export const onNowPlaying = (cb: (n: NowPlaying) => void): Promise<UnlistenFn> =>
	listen<NowPlaying>('now-playing', (e) => cb(e.payload));
/**
 * The backend asked YouTube what a track's rating really is and got a different answer than the
 * row we were handed (issue #93). Fires only on a change, at most once per track start.
 */
export const onRating = (cb: (videoId: string, rating: Rating) => void): Promise<UnlistenFn> =>
	listen<{ videoId: string; rating: Rating }>('rating', (e) =>
		cb(e.payload.videoId, e.payload.rating)
	);
/** Linux and Windows: mpv has this track's music video (or will as soon as the track starts). */
export const onVideoReady = (cb: (videoId: string) => void): Promise<UnlistenFn> =>
	listen<string>('video-ready', (e) => cb(e.payload));
export const onQueueChanged = (cb: (q: QueueState) => void): Promise<UnlistenFn> =>
	listen<QueueState>('queue-changed', (e) => cb(e.payload));
/**
 * The queue moved but its track list did not: only the play pointer and the flags changed.
 * Emitted instead of `queue-changed` on every advance and skip, because the full item list is
 * megabytes on a big playlist and a Tauri event delivers its payload as JavaScript *source*.
 * `current` carries the playing row so a metadata backfill (duration, artists) still lands.
 */
export interface QueueIndex {
	currentIndex: number;
	shuffle?: boolean;
	repeat?: RepeatMode;
	sourceName?: string | null;
	sourceId?: string | null;
	prevTrack?: string | null;
	current: SongItem | null;
}

export const onQueueIndex = (cb: (q: QueueIndex) => void): Promise<UnlistenFn> =>
	listen<QueueIndex>('queue-index', (e) => cb(e.payload));
/**
 * Autoplay topped the queue up at the tail. Carries only the new rows plus the resulting length, so
 * an endless radio session does not re-ship the whole list (which a Tauri event delivers as
 * JavaScript *source*) every twenty tracks. `len` is the resync guard: if the array we hold does
 * not reach that length once the rows are appended, an event was missed and the panel refetches.
 */
export interface QueueAppended {
	items: SongItem[];
	len: number;
	currentIndex: number;
}

export const onQueueAppended = (cb: (q: QueueAppended) => void): Promise<UnlistenFn> =>
	listen<QueueAppended>('queue-appended', (e) => cb(e.payload));
/** Main window shown/hidden (close-to-tray, the mini player). WebKitGTK never tells the page. */
export const onUiVisible = (cb: (v: boolean) => void): Promise<UnlistenFn> =>
	listen<boolean>('ui-visible', (e) => cb(e.payload));
/** `kanade-app <link>` (#348): the arguments a cold launch was given, handed over once... */
export const takeLaunchArgs = () => invoke<string[]>('take_launch_args');
/** ...and those of a second launch while this one runs. */
export const onOpenLink = (cb: (args: string[]) => void): Promise<UnlistenFn> =>
	listen<string[]>('open-link', (e) => cb(e.payload));
export const onPosition = (cb: (p: number) => void): Promise<UnlistenFn> =>
	listen<{ position: number }>('position', (e) => cb(e.payload.position));
export const onDuration = (cb: (d: number) => void): Promise<UnlistenFn> =>
	listen<{ duration: number }>('duration', (e) => cb(e.payload.duration));
/** Echo of every `set_volume`, so a second window's slider can't drift from what you hear. */
export const onVolume = (cb: (v: number) => void): Promise<UnlistenFn> =>
	listen<number>('volume', (e) => cb(e.payload));
export const onPlaybackState = (cb: (s: 'playing' | 'paused') => void): Promise<UnlistenFn> =>
	listen<'playing' | 'paused'>('playback-state', (e) => cb(e.payload));
export const onPlaybackError = (cb: (msg: string) => void): Promise<UnlistenFn> =>
	listen<{ message: string }>('playback-error', (e) => cb(e.payload.message));
export const onPlaybackNotice = (cb: (msg: string) => void): Promise<UnlistenFn> =>
	listen<{ message: string }>('playback-notice', (e) => cb(e.payload.message));
/** Custom playlist artwork applied here but refused by YouTube Music (it syncs in the background,
 *  so the failure lands long after the picker closed). */
export const onCoverError = (cb: (msg: string) => void): Promise<UnlistenFn> =>
	listen<{ message: string }>('cover-error', (e) => cb(e.payload.message));
export const onImportProgress = (cb: (s: ImportSnapshot) => void): Promise<UnlistenFn> =>
	listen<ImportSnapshot>('import-progress', (e) => cb(e.payload));
export const onAuthChanged = (cb: (a: Account) => void): Promise<UnlistenFn> =>
	listen<Account>('auth-changed', (e) => cb(e.payload));
export const onAccountSelectionRequired = (cb: () => void): Promise<UnlistenFn> =>
	listen('account-selection-required', () => cb());
/**
 * Local music disappeared from disk. Fired when a play attempt finds nothing there, carrying the
 * song (and album, if that emptied it) so every view holding those ids can drop them at once.
 */
export const onLocalChanged = (cb: (removed: string[]) => void): Promise<UnlistenFn> =>
	listen<{ removed: string[] }>('local-changed', (e) => cb(e.payload.removed));
export const onLoginError = (cb: (msg: string) => void): Promise<UnlistenFn> =>
	listen<string>('login-error', (e) => cb(e.payload));
export const onLoginDone = (cb: () => void): Promise<UnlistenFn> =>
	listen('login-done', () => cb());

// --- lyrics ---------------------------------------------------------------------------------
export interface LyricWord {
	text: string;
	start_ms: number;
	end_ms: number;
}
export interface LyricLine {
	/** Start cue in milliseconds; present ⇔ the line is synced. */
	time_ms?: number;
	end_time_ms?: number;
	text: string;
	words?: LyricWord[];
	translation?: string;
	/** Latin-script reading of `text` (#202). Word-timed only when Apple Music wrote it. */
	romanized?: string;
	romanized_words?: LyricWord[];
}
export interface Lyrics {
	/** Attribution for the panel footer ("LRCLIB", "Source: Musixmatch", …). */
	source: string;
	/** Id of the provider that answered (`LyricsProvider.id`). */
	provider: string;
	synced: boolean;
	instrumental: boolean;
	lines: LyricLine[];
	/** The source was picked by hand for this song (or its timing nudged). */
	pinned: boolean;
	/** Timing nudge in ms, positive = lyrics later. */
	offset_ms: number;
}
// A type, not an interface: `invoke` takes a record, and only a type alias is assignable to one.
export type LyricsTrack = {
	videoId: string;
	title: string;
	artists: string;
	album?: string;
	duration?: number;
};
/** Cached on the Rust side, down the user's provider order. `null` = none found. `source` asks that
 *  one provider alone and caches nothing (the source picker's preview); it rejects when the
 *  provider couldn't be reached, which is not the same as it having no lyrics. */
export const getLyrics = (args: LyricsTrack & { source?: string }) =>
	invoke<Lyrics | null>('get_lyrics', args);
/** Keep `source`'s lyrics for this song, or (`null`) hand it back to the provider order. */
export const chooseLyricsSource = (args: LyricsTrack & { source: string | null }) =>
	invoke<Lyrics | null>('choose_lyrics_source', args);
export const setLyricsOffset = (videoId: string, offsetMs: number) =>
	invoke<void>('set_lyrics_offset', { videoId, offsetMs });
export interface LyricsProvider {
	id: string;
	name: string;
	on: boolean;
}
/** Every provider in the user's order (setting `lyrics_providers`: ids, `-id` switched off). */
export const lyricsProviders = () => invoke<LyricsProvider[]>('lyrics_providers');

// --- Window ------------------------------------------------------------------------------------
/** Theater mode's fullscreen. Not `getCurrentWindow().setFullscreen` (#139): Windows needs the
 *  maximized state undone first and the frame recalculated after, in that order, on the main
 *  thread. Rust also puts the maximized state back when theater closes. */
export const theaterFullscreen = (on: boolean) => invoke<void>('theater_fullscreen', { on });

// --- Last.fm scrobbling ---------------------------------------------------------------------
export interface LastfmState {
	connected: boolean;
	username?: string | null;
	/** Set when a connect attempt failed (timeout, network, rejected) — show it as a toast. */
	error?: string | null;
}
export const lastfmStatus = () => invoke<LastfmState>('lastfm_status');
/** Opens the browser auth flow; the outcome arrives via onLastfmState, not this promise. */
export const lastfmConnect = () => invoke<void>('lastfm_connect');
/** Also cancels an in-flight connect (the auth poll checks and bails). */
export const lastfmDisconnect = () => invoke<void>('lastfm_disconnect');
export const onLastfmState = (cb: (s: LastfmState) => void): Promise<UnlistenFn> =>
	listen<LastfmState>('lastfm-state', (e) => cb(e.payload));
/** `Profile` in lastfm.rs. Counts are 0 when Last.fm left them out. */
export interface LastfmProfile {
	image: string | null;
	url: string | null;
	scrobbles: number;
	artists: number;
	tracks: number;
	/** Epoch seconds the account was created. */
	since: number;
}
/** `null` when not connected or Last.fm didn't answer. */
export const lastfmProfile = () => invoke<LastfmProfile | null>('lastfm_profile');
/** The track fields the scrobbler reads. A `SongItem` is one. */
export interface ScrobbleTrack {
	video_id: string;
	title: string;
	artists: string;
	album?: string | null;
	is_video?: boolean;
	/** Tells `resolve` which word YouTube joined the artists with in this language (#439). */
	artist_runs?: ArtistRun[];
}
/** `Resolved` in lastfm.rs: what a track scrobbles as, and which settings made it so. */
export interface ScrobblePreview {
	artist: string;
	title: string;
	album: string;
	skip: 'edit' | 'incomplete' | null;
	edit: number | null;
	split: boolean;
	rules: number[];
	errors: [number, string][];
}
/** `config` is the Scrobbling tab's state as JSON, saved or not. */
export const lastfmPreview = (config: string, track: ScrobbleTrack) =>
	invoke<ScrobblePreview>('lastfm_preview', { config, track });

// --- ListenBrainz scrobbling ----------------------------------------------------------------
// Same `ScrobbleTrack`/`ScrobblePreview` shapes as Last.fm: both services send what `resolve`
// in lastfm.rs computes. Only the account calls differ.
export interface ListenBrainzState {
	connected: boolean;
	username?: string | null;
	error?: string | null;
}
export const listenbrainzStatus = () => invoke<ListenBrainzState>('listenbrainz_status');
/** Validates the pasted user token and stores it. Rejects on a bad token or no network. */
export const listenbrainzConnect = (token: string) =>
	invoke<void>('listenbrainz_connect', { token });
export const listenbrainzDisconnect = () => invoke<void>('listenbrainz_disconnect');
export const onListenBrainzState = (cb: (s: ListenBrainzState) => void): Promise<UnlistenFn> =>
	listen<ListenBrainzState>('listenbrainz-state', (e) => cb(e.payload));
/** Why ListenBrainz refuses listens (`problem` in listenbrainz.rs): `email` until the MetaBrainz
 *  email is verified, `rejected` for a token it no longer takes. `null` once one goes through. */
export type ListenBrainzProblem = 'email' | 'rejected';
export const onListenBrainzProblem = (
	cb: (p: ListenBrainzProblem | null) => void
): Promise<UnlistenFn> =>
	listen<ListenBrainzProblem | null>('listenbrainz-problem', (e) => cb(e.payload));
/** `Profile` in listenbrainz.rs. */
export interface ListenBrainzProfile {
	username: string;
	url: string;
	listens: number;
}
/** `null` when not connected or ListenBrainz didn't answer. */
export const listenbrainzProfile = () => invoke<ListenBrainzProfile | null>('listenbrainz_profile');

// --- Listen Together (context/19) -----------------------------------------------------------
export interface LtUser {
	user_id: string;
	username: string;
	is_host: boolean;
	is_connected: boolean;
}
export interface LtTrack {
	id: string;
	title: string;
	artist: string;
	thumbnail?: string | null;
	duration_ms: number;
	/** Name of the guest who added this track to the session queue. */
	queued_by?: string | null;
}
export interface LtPendingJoin {
	userId: string;
	username: string;
}
export interface LtSuggestion {
	id: string;
	from_user_id: string;
	from_username: string;
	track: LtTrack;
}
export interface LtState {
	status: 'disconnected' | 'connecting' | 'connected';
	role: 'none' | 'host' | 'guest';
	/** Asked to create/join and awaiting the room (host approval) — show a waiting state. */
	requesting: boolean;
	roomCode: string | null;
	myId: string | null;
	/** Empty means the built-in default; the backend resolves it when it connects. */
	serverUrl: string;
	/** What that default is. Only ever rendered inside the "change server" panel. */
	defaultServerUrl: string;
	users: LtUser[];
	currentTrack: LtTrack | null;
	queue: LtTrack[];
	pendingJoins: LtPendingJoin[];
	suggestions: LtSuggestion[];
}

export const ltGetState = () => invoke<LtState>('lt_get_state');
export const ltSetServerUrl = (url: string) => invoke<void>('lt_set_server_url', { url });
export const ltCreateRoom = (username: string) => invoke<void>('lt_create_room', { username });
export const ltJoinRoom = (code: string, username: string) =>
	invoke<void>('lt_join_room', { code, username });
export const ltLeave = () => invoke<void>('lt_leave');
export const ltApproveJoin = (userId: string) => invoke<void>('lt_approve_join', { userId });
export const ltRejectJoin = (userId: string) => invoke<void>('lt_reject_join', { userId });
export const ltKick = (userId: string) => invoke<void>('lt_kick', { userId });
export const ltTransferHost = (userId: string) => invoke<void>('lt_transfer_host', { userId });
export const ltApproveSuggestion = (id: string) => invoke<void>('lt_approve_suggestion', { id });
export const ltRejectSuggestion = (id: string) => invoke<void>('lt_reject_suggestion', { id });
export const ltRequestSync = () => invoke<void>('lt_request_sync');

export const onLtState = (cb: (s: LtState) => void): Promise<UnlistenFn> =>
	listen<LtState>('lt-state', (e) => cb(e.payload));
export const onLtNotice = (cb: (msg: string) => void): Promise<UnlistenFn> =>
	listen<string>('lt-notice', (e) => cb(e.payload));

export const getMatugenTheme = () => invoke<string | null>('get_matugen_theme');
export const onMatugenThemeChanged = (cb: (css: string | null) => void): Promise<UnlistenFn> =>
	listen<string | null>('matugen-theme-changed', (event) => cb(event.payload));
export const startMatugenWatcher = () => invoke<void>('start_matugen_watcher');
export const stopMatugenWatcher = () => invoke<void>('stop_matugen_watcher');

// --- Song Downloader ----------------------------------------------------------------------

export interface DownloadRequest {
	video_id: string;
	title: string;
	artists: string;
	album?: string;
	thumbnail?: string;
	duration_secs?: number;
	quality: string;
	output_dir?: string;
}

export interface DownloadProgress {
	id: string;
	video_id: string;
	title: string;
	artists: string;
	quality: string;
	status: 'queued' | 'downloading' | 'transcoding' | 'tagging' | 'completed' | 'failed' | 'cancelled';
	percent: number;
	bytes_downloaded: number;
	total_bytes: number;
	speed_mbps: number;
	file_path?: string;
	error?: string;
}

export const startDownload = (req: DownloadRequest) =>
	invoke<string>('start_download', { req });
export const startDownloadsBatch = (requests: DownloadRequest[]) =>
	invoke<string[]>('start_downloads_batch', { requests });
export const cancelDownload = (id: string) =>
	invoke<boolean>('cancel_download', { id });
export const getActiveDownloads = () =>
	invoke<DownloadProgress[]>('get_active_downloads');
export const getDefaultDownloadDir = () =>
	invoke<string>('get_default_download_dir');
export const openDownloadDir = (path?: string) =>
	invoke<void>('open_download_dir', { path });
export const showItemInFolder = (path: string) =>
	invoke<void>('show_item_in_folder', { path });

export const onDownloadProgress = (cb: (p: DownloadProgress) => void): Promise<UnlistenFn> =>
	listen<DownloadProgress>('download_progress', (e) => cb(e.payload));

