/**
 * Content in the data dir is its owner's alone, as the database file is: an
 * upload, a trashed document's snapshot, an export or an installed font
 * written under the umask lands 0644 in 0755 directories, which on a host
 * bind mount every host user can read. Directories that already exist keep
 * the mode they have — an operator's mount is theirs to set.
 */
export const DATA_DIR_MODE = 0o700
export const DATA_FILE_MODE = 0o600
