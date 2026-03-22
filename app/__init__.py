from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.config import APP_VERSION
from app.services import settings as app_settings
from app.services import spotify


def create_app() -> FastAPI:
    app = FastAPI(title="MusicSeeker", version=APP_VERSION)

    # Include routers
    from app.routers import auth, search, spotify as spotify_router, downloads, player, discover, favorites, podcasts, settings, admin
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
            "spotify_available": bool(spotify.SPOTIFY_CLIENT_ID and spotify.SPOTIFY_CLIENT_SECRET),
            "spotify_user": bool(spotify._get_global_refresh_token()),
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
