/**
 * Utility functions
 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Convert a full URL to a relative path (pathname + search).
 * Use for same-origin requests to avoid CORS (e.g. fetch, links).
 */
export function toRelativePath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}
