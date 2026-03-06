/**
 * Next.js Middleware
 * Handles authentication checks for protected routes
 * Note: Authentication is handled at the API route level for better control
 */
export { default } from 'next-auth/middleware'

export const config = {
  matcher: ['/dashboard/:path*'],
}
