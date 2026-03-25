from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str
    password: str


class DownloadRequest(BaseModel):
    url: str = ""
    title: str = ""
    method: str = "yt-dlp"
    format: str = "flac"
    type: str = "track"
    playlist_name: str = ""
    playlist_tracks: list[dict] = []


class ResolveRequest(BaseModel):
    name: str
    artist: str = ""
    type: str = "track"


class FollowArtistRequest(BaseModel):
    artist_id: str
    name: str
    image: str = ""


class UpdateFavoriteRequest(BaseModel):
    auto_download: bool | None = None


class LibraryCheckRequest(BaseModel):
    items: list[dict]


class SettingsUpdate(BaseModel):
    default_format: str | None = None
    default_method: str | None = None
    search_provider: str | None = None
    search_fallback: str | None = None
    podcast_provider: str | None = None
    max_concurrent: int | None = None
    navidrome_url: str | None = None
    navidrome_user: str | None = None
    navidrome_password: str | None = None
    slskd_url: str | None = None
    slskd_api_key: str | None = None
    recommendation_source: str | None = None
    spotify_refresh_token: str | None = None
    dlna_renderer_url: str | None = None


class CreateUserRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False
    allowed_formats: list[str] = ["mp3", "flac"]
    allowed_methods: list[str] = ["yt-dlp", "slskd", "lidarr"]


class UpdateUserPermsRequest(BaseModel):
    allowed_formats: list[str] | None = None
    allowed_methods: list[str] | None = None
    quota_gb: float | None = None


class ChangePasswordRequest(BaseModel):
    new_password: str


class SpotifyConnectRequest(BaseModel):
    client_id: str
    client_secret: str
    refresh_token: str


class UserSettingRequest(BaseModel):
    hide_spotify: bool | None = None


class QueueState(BaseModel):
    queue: list[dict] = []
    current_index: int = -1
    position_seconds: float = 0.0
    volume: float = 1.0
    playlist_mode: dict | None = None


class AddToQueueRequest(BaseModel):
    tracks: list[dict]
    play_now: bool = False


class CreatePlaylistRequest(BaseModel):
    name: str


class AddTracksByIdRequest(BaseModel):
    song_ids: list[str]


class RemoveTracksRequest(BaseModel):
    indices: list[int]


class AddTrackByNameRequest(BaseModel):
    name: str
    artist: str = ""
    album: str = ""


class DeleteAlbumRequest(BaseModel):
    artist: str
    album: str


class RecommendationRequest(BaseModel):
    tracks: list[dict]
    limit: int = 15


class PodcastSubRequest(BaseModel):
    show_name: str
    spotify_id: str
    image: str = ""
    max_episodes: int = 0
    feed_url: str = ""


class PodcastSubUpdate(BaseModel):
    max_episodes: int | None = None
