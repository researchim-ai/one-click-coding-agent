/**
 * Global test bootstrap. Runs *before* any test file is imported, so any
 * `os.homedir()`-based module constants (archive, checkpoints, debug log,
 * sessions dir, ...) resolve to a throwaway directory instead of the
 * developer's real $HOME.
 *
 * We create a process-wide temp home once and let individual tests nest
 * their own per-test subdirectories if they need isolation.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-tests-home-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome // Windows compatibility
