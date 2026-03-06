# CORS Error Handling - Technical Guide

## What is CORS?
CORS (Cross-Origin Resource Sharing) is a browser security feature that blocks requests from one domain to another unless the server explicitly allows it.

## Common CORS Error Messages
- `Access to fetch at '...' from origin '...' has been blocked by CORS policy`
- `No 'Access-Control-Allow-Origin' header is present`
- `Preflight request doesn't pass access control check`

---

## Solutions by Scenario

### 1. **Server-Side API (Next.js API Routes) - RECOMMENDED**

If you control the server, add CORS headers to your API routes:

```typescript
// app/api/your-route/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  // Get the origin from the request
  const origin = request.headers.get('origin')
  
  // Define CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*', // Use specific origin in production
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true', // If using cookies/auth
  }

  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { 
      status: 200, 
      headers: corsHeaders 
    })
  }

  // Your actual API logic here
  const data = await request.json()
  
  return NextResponse.json(
    { success: true, data },
    { headers: corsHeaders }
  )
}
```

**For Production:**
```typescript
// Only allow specific origins (more secure)
const allowedOrigins = [
  'https://yourdomain.com',
  'https://www.yourdomain.com',
  'http://localhost:3000', // For development
]

const origin = request.headers.get('origin')
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') 
    ? origin 
    : 'null',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
}
```

---

### 2. **Client-Side: Use Next.js API Route as Proxy**

If you can't modify the external API, create a proxy in your Next.js app:

```typescript
// app/api/proxy/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { url, method = 'GET', headers = {}, data } = body

    // Make the request from server (no CORS restrictions)
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    })

    const result = await response.json()

    // Return with CORS headers
    return NextResponse.json(result, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Proxy request failed' },
      { status: 500 }
    )
  }
}
```

**Client-side usage:**
```typescript
// Instead of calling external API directly:
// fetch('https://external-api.com/data') // ❌ CORS error

// Call your proxy:
const response = await fetch('/api/proxy', {
  method: 'POST',
  body: JSON.stringify({
    url: 'https://external-api.com/data',
    method: 'GET',
  }),
}) // ✅ Works!
```

---

### 3. **Next.js Middleware (Global CORS)**

For all API routes, add to `middleware.ts`:

```typescript
// middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Handle CORS for API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const origin = request.headers.get('origin')
    
    const response = NextResponse.next()
    
    response.headers.set('Access-Control-Allow-Origin', origin || '*')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.headers.set('Access-Control-Allow-Credentials', 'true')

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, { status: 200, headers: response.headers })
    }

    return response
  }
}

export const config = {
  matcher: '/api/:path*',
}
```

---

### 4. **External API - If You Control It**

If the external API is yours, configure CORS on the server:

**Express.js:**
```javascript
const cors = require('cors')
app.use(cors({
  origin: ['https://yourdomain.com', 'http://localhost:3000'],
  credentials: true,
}))
```

**Node.js/Express (Manual):**
```javascript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://yourdomain.com')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Credentials', 'true')
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200)
  }
  next()
})
```

**PHP:**
```php
<?php
header('Access-Control-Allow-Origin: https://yourdomain.com');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Credentials: true');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}
?>
```

---

### 5. **Client-Side Workarounds (Not Recommended for Production)**

**A. Disable CORS in Browser (Development Only)**
```bash
# Chrome (Windows)
chrome.exe --user-data-dir="C:/Chrome dev session" --disable-web-security

# Chrome (Mac)
open -na Google\ Chrome --args --user-data-dir=/tmp/chrome_dev --disable-web-security
```

**B. Browser Extension (Development Only)**
- Install "CORS Unblock" or similar extension
- ⚠️ **Never use in production!**

---

### 6. **For Your Current Codebase**

Your embed chat route already handles CORS. If you need to add CORS to other routes:

**Template for new API routes:**
```typescript
// app/api/your-route/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 200, headers: corsHeaders })
  }

  try {
    // Your API logic here
    const body = await request.json()
    
    return NextResponse.json(
      { success: true },
      { headers: corsHeaders }
    )
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    )
  }
}
```

---

## Common Issues & Solutions

### Issue 1: Preflight (OPTIONS) Request Failing
**Solution:** Always handle OPTIONS method:
```typescript
if (request.method === 'OPTIONS') {
  return new NextResponse(null, { status: 200, headers: corsHeaders })
}
```

### Issue 2: Credentials Not Working
**Solution:** Add `Access-Control-Allow-Credentials`:
```typescript
'Access-Control-Allow-Credentials': 'true'
// And in client: fetch(url, { credentials: 'include' })
```

### Issue 3: Custom Headers Blocked
**Solution:** Add them to `Access-Control-Allow-Headers`:
```typescript
'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Custom-Header'
```

### Issue 4: Wildcard Origin with Credentials
**Problem:** Can't use `'*'` with `credentials: true`
**Solution:** Use specific origin:
```typescript
'Access-Control-Allow-Origin': 'https://yourdomain.com' // Not '*'
'Access-Control-Allow-Credentials': 'true'
```

---

## Testing CORS

**Check CORS headers:**
```bash
curl -H "Origin: http://localhost:3000" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: Content-Type" \
     -X OPTIONS \
     https://your-api.com/api/endpoint \
     -v
```

**Expected response headers:**
```
Access-Control-Allow-Origin: http://localhost:3000
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

---

## Best Practices

1. ✅ **Always handle OPTIONS preflight requests**
2. ✅ **Use specific origins in production** (not `'*'`)
3. ✅ **Use server-side proxy** for external APIs you don't control
4. ✅ **Add CORS headers to all responses** (success and error)
5. ✅ **Test with actual browser** (not just curl)
6. ❌ **Never disable CORS in production**
7. ❌ **Don't use wildcard origin with credentials**

---

## Quick Reference

| Scenario | Solution |
|----------|----------|
| Your Next.js API | Add CORS headers to route |
| External API (no control) | Create Next.js proxy route |
| External API (you control) | Configure CORS on that server |
| Development only | Browser flag/extension (not recommended) |
| All API routes | Use Next.js middleware |

---

## Example: Adding CORS to Existing Route

```typescript
// Before (no CORS)
export async function POST(request: NextRequest) {
  const data = await request.json()
  return NextResponse.json({ success: true, data })
}

// After (with CORS)
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 200, headers: corsHeaders })
  }

  const data = await request.json()
  return NextResponse.json(
    { success: true, data },
    { headers: corsHeaders }
  )
}
```
