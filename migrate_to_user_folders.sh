#!/bin/bash
# Migration script: Move existing music files to per-user folder structure
# Usage: ./migrate_to_user_folders.sh <username>
# Example: ./migrate_to_user_folders.sh lucas
#
# This script:
# 1. Backs up Navidrome DB
# 2. Stops Navidrome
# 3. Moves music files to /music/<username>/
# 4. Updates Navidrome DB paths
# 5. Restarts Navidrome
#
# Run on the YAMS server (192.168.1.22) as deploy user with sudo

set -euo pipefail

USERNAME="${1:-}"
if [ -z "$USERNAME" ]; then
    echo "Usage: $0 <username>"
    echo "Example: $0 lucas"
    exit 1
fi

MUSIC_DIR="/mnt/nas/Media/_Music"
NAVIDROME_DB="/home/yams/yams-server/config/navidrome/navidrome.db"
BACKUP_DIR="/home/yams/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/navidrome_${TIMESTAMP}.db"

# Directories to skip (not user content)
SKIP_DIRS=".slskd-downloads .slskd-incomplete playlists"

echo "=== MusicSeeker Migration: Move files to ${USERNAME}/ ==="
echo ""

# Step 0: Preflight checks
echo "[0/6] Preflight checks..."
if [ ! -f "$NAVIDROME_DB" ]; then
    echo "ERROR: Navidrome DB not found at $NAVIDROME_DB"
    exit 1
fi
if [ ! -d "$MUSIC_DIR" ]; then
    echo "ERROR: Music directory not found at $MUSIC_DIR"
    exit 1
fi
if [ -d "${MUSIC_DIR}/${USERNAME}" ]; then
    echo "WARNING: ${MUSIC_DIR}/${USERNAME} already exists. Migration will merge into it."
fi

# Count what we're moving
DIRS_TO_MOVE=0
for d in "$MUSIC_DIR"/*/; do
    [ ! -d "$d" ] && continue
    dirname=$(basename "$d")
    # Skip hidden dirs, skip dirs, and target username dir
    [[ "$dirname" == .* ]] && continue
    echo "$SKIP_DIRS" | grep -qw "$dirname" && continue
    [ "$dirname" = "$USERNAME" ] && continue
    DIRS_TO_MOVE=$((DIRS_TO_MOVE + 1))
done
echo "  Found $DIRS_TO_MOVE directories to move"
echo "  Target: ${MUSIC_DIR}/${USERNAME}/"
echo ""

read -p "Continue? (y/N) " confirm
[ "$confirm" != "y" ] && echo "Aborted." && exit 0

# Step 1: Backup DB
echo ""
echo "[1/6] Backing up Navidrome database..."
sudo mkdir -p "$BACKUP_DIR"
sudo cp "$NAVIDROME_DB" "$BACKUP_FILE"
# Also copy WAL if exists
[ -f "${NAVIDROME_DB}-wal" ] && sudo cp "${NAVIDROME_DB}-wal" "${BACKUP_FILE}-wal"
[ -f "${NAVIDROME_DB}-shm" ] && sudo cp "${NAVIDROME_DB}-shm" "${BACKUP_FILE}-shm"
echo "  Backup saved to: $BACKUP_FILE"

# Step 2: Stop Navidrome
echo ""
echo "[2/6] Stopping Navidrome..."
sudo docker stop navidrome
echo "  Navidrome stopped"

# Step 3: Move files
echo ""
echo "[3/6] Moving music files to ${USERNAME}/..."
sudo mkdir -p "${MUSIC_DIR}/${USERNAME}"

MOVED=0
ERRORS=0
for d in "$MUSIC_DIR"/*/; do
    [ ! -d "$d" ] && continue
    dirname=$(basename "$d")
    [[ "$dirname" == .* ]] && continue
    echo "$SKIP_DIRS" | grep -qw "$dirname" && continue
    [ "$dirname" = "$USERNAME" ] && continue

    dest="${MUSIC_DIR}/${USERNAME}/${dirname}"
    if [ -d "$dest" ]; then
        # Merge: move contents
        echo "  Merging: $dirname/ (already exists in target)"
        sudo cp -rn "$d"* "$dest/" 2>/dev/null || true
        sudo rm -rf "$d"
    else
        sudo mv "$d" "$dest"
    fi
    MOVED=$((MOVED + 1))
done
echo "  Moved $MOVED directories"

# Step 4-5: Update Navidrome DB using Python (sqlite3 CLI not available on host)
echo ""
echo "[4/6] Updating Navidrome database paths..."

DB_RESULT=$(sudo python3 -c "
import sqlite3, time

conn = sqlite3.connect('${NAVIDROME_DB}')
cur = conn.cursor()

cur.execute('PRAGMA wal_checkpoint(TRUNCATE);')

cur.execute(\"UPDATE media_file SET path = '${USERNAME}/' || path WHERE path NOT LIKE '${USERNAME}/%' AND path NOT LIKE '.slskd%';\")
mf_count = cur.rowcount

cur.execute(\"UPDATE album SET embed_art_path = '${USERNAME}/' || embed_art_path WHERE embed_art_path <> '' AND embed_art_path NOT LIKE '${USERNAME}/%' AND embed_art_path NOT LIKE '.slskd%';\")
album_count = cur.rowcount

conn.commit()

cur.execute(\"SELECT id, library_id FROM folder WHERE parent_id = '' LIMIT 1;\")
row = cur.fetchone()
reparented = 0
if row:
    root_id, lib_id = row
    cur.execute(\"SELECT id FROM folder WHERE name = '${USERNAME}' AND parent_id = ?;\", (root_id,))
    existing = cur.fetchone()
    if existing:
        user_folder_id = existing[0]
    else:
        user_folder_id = f'usr_${USERNAME}_{int(time.time())}'
        cur.execute(\"INSERT INTO folder (id, library_id, path, name, parent_id, missing, num_audio_files, num_playlists) VALUES (?, ?, '.', '${USERNAME}', ?, 0, 0, 0);\", (user_folder_id, lib_id, root_id))
    cur.execute(\"UPDATE folder SET parent_id = ? WHERE parent_id = ? AND name <> '${USERNAME}' AND name NOT LIKE '.%' AND name <> 'playlists';\", (user_folder_id, root_id))
    reparented = cur.rowcount
    conn.commit()

conn.close()
print(f'{mf_count}|{album_count}|{reparented}')
")

IFS='|' read -r UPDATED_MF UPDATED_ALBUM REPARENTED <<< "$DB_RESULT"
echo "  Updated $UPDATED_MF media_file paths"
echo ""
echo "[5/6] Updating album art paths..."
echo "  Updated $UPDATED_ALBUM album art paths"
echo "  Re-parented $REPARENTED folders under ${USERNAME}"

# Step 6: Restart Navidrome
echo ""
echo "[6/6] Starting Navidrome..."
sudo docker start navidrome
echo "  Navidrome started"

# Trigger a scan
sleep 3
echo ""
echo "Triggering Navidrome scan..."
curl -s "http://localhost:4533/rest/startScan?v=1.16.1&c=migrate&u=lucas&p=Poiwer3122." > /dev/null 2>&1 || true

echo ""
echo "=== Migration complete ==="
echo ""
echo "Summary:"
echo "  - Moved $MOVED directories to ${MUSIC_DIR}/${USERNAME}/"
echo "  - Updated $UPDATED_MF media file paths in DB"
echo "  - Updated $UPDATED_ALBUM album art paths in DB"
echo "  - Re-parented $REPARENTED folders in DB"
echo "  - DB backup at: $BACKUP_FILE"
echo ""
echo "To verify:"
echo "  1. Open Navidrome and check that music plays"
echo "  2. Check playlists still work"
echo "  3. Check MusicSeeker disk usage shows '${USERNAME}' folder"
echo ""
echo "To rollback if something is wrong:"
echo "  sudo docker stop navidrome"
echo "  sudo cp ${BACKUP_FILE} ${NAVIDROME_DB}"
echo "  [ -f ${BACKUP_FILE}-wal ] && sudo cp ${BACKUP_FILE}-wal ${NAVIDROME_DB}-wal"
echo "  [ -f ${BACKUP_FILE}-shm ] && sudo cp ${BACKUP_FILE}-shm ${NAVIDROME_DB}-shm"
echo "  # Then move files back: sudo mv ${MUSIC_DIR}/${USERNAME}/* ${MUSIC_DIR}/"
echo "  sudo docker start navidrome"
