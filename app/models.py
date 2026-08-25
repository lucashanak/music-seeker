from pydantic import BaseModel, Field


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
    discovery_genres: str | None = None
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
    description: str | None = None


class PlaylistDetailsRequest(BaseModel):
    name: str | None = None
    description: str | None = None


class PlaylistCoverRequest(BaseModel):
    image_url: str


class AddTracksByIdRequest(BaseModel):
    song_ids: list[str]


class RemoveTracksRequest(BaseModel):
    indices: list[int]


class AddTrackByNameRequest(BaseModel):
    name: str
    artist: str = ""
    album: str = ""
    index: int | None = None  # optional exact row index to remove (duplicate-safe)


class DeleteAlbumRequest(BaseModel):
    artist: str
    album: str


class PrewarmRequest(BaseModel):
    tracks: list[dict] = []  # [{name, artist, id}], bounded to <=3 server-side


class RecommendationRequest(BaseModel):
    tracks: list[dict]
    limit: int = Field(15, ge=1, le=50)
    skipped: list[dict] = []
    accepted: list[dict] = []
    tempo_coherent: bool = False
    # Scene anchors for co-occurrence mining — typically the source playlist's
    # name. Measured to matter more than any scoring change: a playlist whose
    # name names its scene had 49 of 53 held-out members reachable, one whose
    # name does not had a fraction of that.
    anchors: list[str] = Field(default_factory=list, max_length=8)


class LikeRequest(BaseModel):
    name: str
    artist: str = ""
    album: str = ""
    id: str = ""
    image: str = ""


class PodcastSubRequest(BaseModel):
    show_name: str
    spotify_id: str
    image: str = ""
    max_episodes: int = 0
    feed_url: str = ""


class PodcastSubUpdate(BaseModel):
    max_episodes: int | None = None


class DeviceSettingRequest(BaseModel):
    name: str = ""
    output_mode: str = "default"  # "default" | "local" | "dlna_only"
    dlna_renderer_url: str = ""


class FeedbackRequest(BaseModel):
    kind: str = "bug"          # "bug" | "feature"
    # Limits match the truncation applied in app/services/feedback.py so an
    # over-long submission gets a clear 422 instead of silent data loss.
    title: str = Field(max_length=120)
    description: str = Field("", max_length=5000)
    # data URL: "data:image/jpeg;base64,...." — capped so an oversized payload is
    # rejected at parse time, before any base64 decode is attempted.
    screenshot: str = Field("", max_length=6 * 1024 * 1024)
    context: dict = {}


class FeedbackPromoteRequest(BaseModel):
    title: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=8000)
