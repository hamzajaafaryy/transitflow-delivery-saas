const api = process.env.TF_API_URL || 'http://127.0.0.1:3100';
const upstream = new URL(api);
if (upstream.origin !== api || !['http:', 'https:'].includes(upstream.protocol)) throw Error('Invalid TF_API_URL');

export default {
  poweredByHeader: false,
  async rewrites() {
    return [{source:'/api/v2/:path*',destination:api+'/api/v2/:path*'}];
  },
  async headers() {
    const production=process.env.NODE_ENV==='production';
    return [{
      source:'/:path*',
      headers:[
        {key:'X-Robots-Tag',value:'noindex, nofollow'},
        {key:'X-Frame-Options',value:'DENY'},
        {key:'X-Content-Type-Options',value:'nosniff'},
        {key:'Referrer-Policy',value:'no-referrer'},
        {key:'Permissions-Policy',value:'camera=(self), serial=(self), microphone=(), geolocation=()'},
        ...(production?[{key:'Content-Security-Policy',
          value:"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"}]:[]),
      ],
    }];
  },
};
