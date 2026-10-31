// Client only: the app starts from data files and browser state.
export const prerender = true;
export const ssr = false;
// Each route is built as <route>/index.html, which any static host serves without a rewrite.
export const trailingSlash = 'always';
