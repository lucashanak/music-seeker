import logging

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from app.config import APP_VERSION
from app.services import settings as app_settings
from app.services import spotify


def create_app() -> FastAPI:
    # Root logger stays at WARNING: the production host runs an uncapped docker
    # json-file log driver on a small (63GB) disk that has already caused an outage,
    # so switching on logger.info globally would light up every module (bpm.py,
    # radio.py, spotify.py, search_providers.py, ...) at once. Recognition is a rare,
    # user-initiated action, so only its logger is raised to INFO — bounded, cheap
    # instrumentation without that blast radius.
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("app.services.recognize").setLevel(logging.INFO)

    app = FastAPI(title="MusicSeeker", version=APP_VERSION)

    # Include routers
    from app.routers import auth, search, spotify as spotify_router, downloads, player, discover, favorites, podcasts, settings, admin, library as library_router, dlna as dlna_router, bpm as bpm_router, recognize as recognize_router, remote as remote_router, feedback as feedback_router, importer as importer_router
    app.include_router(auth.router)
    app.include_router(search.router)
    app.include_router(spotify_router.router)
    app.include_router(downloads.router)
    app.include_router(player.router)
    app.include_router(discover.router)
    app.include_router(favorites.router)
    app.include_router(podcasts.router)
    app.include_router(settings.router)
    app.include_router(admin.router)
    app.include_router(library_router.router)
    app.include_router(dlna_router.router)
    app.include_router(bpm_router.router)
    app.include_router(recognize_router.router)
    app.include_router(remote_router.router)
    app.include_router(feedback_router.router)
    app.include_router(importer_router.router)

    # A lapsed Premium subscription on the app owner's account 403s every Spotify
    # endpoint, which spotify.py latches into SpotifyUnavailable. Nothing caught it,
    # so those requests surfaced as opaque 500s. 503 + a flag lets the frontend say
    # "Spotify is unavailable" instead of "something broke".
    @app.exception_handler(spotify.SpotifyUnavailable)
    async def spotify_unavailable_handler(request: Request, exc: spotify.SpotifyUnavailable):
        return JSONResponse(status_code=503, content={"detail": str(exc), "spotify_unavailable": True})

    # Apply saved settings to library/downloader modules
    app_settings._apply_to_modules()

    # Background tasks
    from app.background import startup
    app.on_event("startup")(startup)

    # Version endpoint — kept unauthenticated for pre-login cache busting
    @app.get("/api/version")
    async def get_version():
        return {
            "version": APP_VERSION,
            "search_provider": app_settings._settings.get("search_provider", "deezer"),
            "search_fallback": app_settings._settings.get("search_fallback", ""),
            "podcast_provider": app_settings._settings.get("podcast_provider", "itunes"),
            # Credentials being present is not the same as the API answering:
            # an expired Premium subscription on the app owner's account 403s
            # every endpoint. Report the health latch so the frontend greys the
            # Spotify features out rather than showing them broken.
            "spotify_available": bool(spotify.SPOTIFY_CLIENT_ID and spotify.SPOTIFY_CLIENT_SECRET
                                      and spotify.api_available()),
            "spotify_user": bool(spotify._get_global_refresh_token()),
            "spotify_status": spotify.api_status(),
        }

    # Static files
    app.mount("/static", StaticFiles(directory="static"), name="static")

    @app.get("/favicon.ico")
    @app.get("/favicon.svg")
    async def favicon():
        return FileResponse("static/favicon.svg", media_type="image/svg+xml")

    @app.get("/")
    async def index():
        return FileResponse(
            "static/index.html",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "ETag": f'"{APP_VERSION}"',
            },
        )

    return app
