from fastapi import APIRouter, HTTPException, Depends

from app.models import FollowArtistRequest, UpdateFavoriteRequest
from app.services import auth, favorites

router = APIRouter(prefix="/api/favorites", tags=["favorites"])


@router.get("")
async def get_favorites_list(user: dict = Depends(auth.get_current_user)):
    artists = favorites.get_favorites(user["username"])
    return {"artists": artists}


@router.post("")
async def follow_artist(req: FollowArtistRequest, user: dict = Depends(auth.get_current_user)):
    ok = await favorites.follow_artist(user["username"], req.artist_id, req.name, req.image)
    if not ok:
        raise HTTPException(409, "Already following this artist")
    return {"status": "followed"}


@router.delete("/{artist_id}")
async def unfollow_artist(artist_id: str, user: dict = Depends(auth.get_current_user)):
    if not favorites.unfollow_artist(user["username"], artist_id):
        raise HTTPException(404, "Not following this artist")
    return {"status": "unfollowed"}


@router.put("/{artist_id}")
async def update_favorite(artist_id: str, req: UpdateFavoriteRequest, user: dict = Depends(auth.get_current_user)):
    updates = req.model_dump(exclude_none=True)
    if not favorites.update_artist(user["username"], artist_id, updates):
        raise HTTPException(404, "Not following this artist")
    return {"status": "updated"}


@router.post("/{artist_id}/clear")
async def clear_favorite_release(artist_id: str, user: dict = Depends(auth.get_current_user)):
    favorites.clear_new_release(user["username"], artist_id)
    return {"status": "cleared"}


@router.post("/check")
async def check_favorites_now(user: dict = Depends(auth.get_current_user)):
    new_count = await favorites.check_new_releases()
    return {"new_count": new_count}
