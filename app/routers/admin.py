import os

from fastapi import APIRouter, HTTPException, Depends

from app.models import CreateUserRequest, UpdateUserPermsRequest
from app.services import auth, downloader
from app.dependencies import _get_dir_size

router = APIRouter(prefix="/api", tags=["admin"])


@router.get("/users")
async def get_users(user: dict = Depends(auth.require_admin)):
    return {"users": auth.list_users()}


@router.post("/users")
async def create_user(req: CreateUserRequest, user: dict = Depends(auth.require_admin)):
    if not auth.create_user(req.username, req.password, req.is_admin,
                            req.allowed_formats, req.allowed_methods):
        raise HTTPException(409, "User already exists")
    return {"status": "created", "username": req.username}


@router.put("/users/{username}/perms")
async def update_user_perms(username: str, req: UpdateUserPermsRequest, user: dict = Depends(auth.require_admin)):
    if not auth.update_user_perms(username, req.allowed_formats, req.allowed_methods, req.quota_gb):
        raise HTTPException(404, "User not found")
    return {"status": "updated"}


@router.delete("/users/{username}")
async def delete_user(username: str, user: dict = Depends(auth.require_admin)):
    if username == user["username"]:
        raise HTTPException(400, "Cannot delete yourself")
    if not auth.delete_user(username):
        raise HTTPException(404, "User not found")
    return {"status": "deleted"}


@router.get("/admin/disk-usage")
async def get_disk_usage(user: dict = Depends(auth.require_admin)):
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    all_users = {u["username"]: u for u in auth.list_users()}
    usage = []
    for entry in sorted(os.scandir(music_dir), key=lambda e: e.name):
        if not entry.is_dir() or entry.name.startswith('.'):
            continue
        total, file_count = _get_dir_size(entry.path)
        item = {"name": entry.name, "size_bytes": total, "file_count": file_count}
        # Add quota info if this is a user folder
        if entry.name in all_users:
            item["quota_gb"] = all_users[entry.name].get("quota_gb", 0)
        usage.append(item)
    return {"usage": usage}


@router.get("/admin/disk-usage/{dirname}/subfolders")
async def get_subfolders(dirname: str, user: dict = Depends(auth.require_admin)):
    if dirname.startswith('.') or '/' in dirname or '\\' in dirname:
        raise HTTPException(400, "Invalid directory name")
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    target = os.path.join(music_dir, dirname)
    if not os.path.isdir(target):
        raise HTTPException(404, "Directory not found")
    subs = []
    for entry in sorted(os.scandir(target), key=lambda e: e.name):
        if not entry.is_dir() or entry.name.startswith('.'):
            continue
        total, file_count = _get_dir_size(entry.path)
        subs.append({"name": entry.name, "size_bytes": total, "file_count": file_count})
    return {"subfolders": subs}


@router.delete("/admin/disk-usage/{dirname}")
async def delete_user_downloads(dirname: str, subfolder: str | None = None, user: dict = Depends(auth.require_admin)):
    import shutil
    if dirname.startswith('.') or '/' in dirname or '\\' in dirname:
        raise HTTPException(400, "Invalid directory name")
    if subfolder and (subfolder.startswith('.') or '/' in subfolder or '\\' in subfolder):
        raise HTTPException(400, "Invalid subfolder name")
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    target = os.path.join(music_dir, dirname, subfolder) if subfolder else os.path.join(music_dir, dirname)
    if not os.path.isdir(target):
        raise HTTPException(404, "Directory not found")
    shutil.rmtree(target)
    await downloader._trigger_navidrome_scan()
    return {"status": "deleted", "name": subfolder or dirname}
