/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ensure Node.js runtime is used for all routes
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // API routes and server components use Node.js runtime (default)
  // No edge runtime configuration needed
  images: {
    domains: [],
  },
  // File upload configuration
  serverRuntimeConfig: {
    // Will be available on both server and client
    uploadDir: process.env.UPLOAD_DIR || './uploads',
  },
  // Webpack configuration for Node.js modules like jsdom
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Handle Node.js modules that aren't available in the browser
      config.externals = config.externals || []
      // Don't externalize jsdom - we need it on the server
    }
    return config
  },
}

module.exports = nextConfig
