import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, HOTKEY_CHOICES, type Settings } from '../shared/settings'

/**
 * Application preferences, stored as JSON in userData.
 *
 * Deliberately not in the SQLite index: the index is owned (and exclusively
 * written) by the worker, while these are main's concern and must be readable
 * before the worker has even started. They also survive a "rebuild the index"
 * action, which the folder list in particular has to.
 */
let cached: Settings | null = null
const listeners = new Set<(settings: Settings) => void>()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Coerces arbitrary parsed JSON into a valid Settings object.
 *
 * The file is user-editable and survives upgrades, so every field is treated as
 * untrusted: a hand-edited hotkey that Electron cannot register would otherwise
 * leave the app with no way to open at all.
 */
function sanitize(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const input = raw as Record<string, unknown>

  const folders = Array.isArray(input.folders)
    ? [...new Set(input.folders.filter((entry): entry is string => typeof entry === 'string'))]
    : []

  const hotkey =
    typeof input.hotkey === 'string' && (HOTKEY_CHOICES as readonly string[]).includes(input.hotkey)
      ? input.hotkey
      : DEFAULT_SETTINGS.hotkey

  return {
    folders,
    hotkey,
    onboarded: input.onboarded === true
  }
}

export function getSettings(): Settings {
  if (cached) return cached

  try {
    cached = sanitize(JSON.parse(readFileSync(settingsPath(), 'utf8')))
  } catch {
    // Missing on first run, or corrupt. Either way, defaults are correct and a
    // corrupt file should not stop the app from starting.
    cached = { ...DEFAULT_SETTINGS }
  }

  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = sanitize({ ...getSettings(), ...patch })
  cached = next

  const target = settingsPath()
  const temporary = `${target}.tmp`
  try {
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // silently resets every preference on next launch.
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    console.error('[trove] failed to persist settings', error)
  }

  for (const listener of listeners) listener(next)
  return next
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
