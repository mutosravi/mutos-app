// app.mutosstudio.com front door (Cloudflare Pages). Pages serves the app's pages from ./public;
// anything under /api/ is handed to the mutos-app Worker (reminders, backups, Team Alignment, notifications)
// through the service binding "API" set in the Pages project settings. Keeps the domain's DNS at Hostinger:
// only one CNAME record (app → this Pages project) is needed, so the website and email are not touched.
export async function onRequest({ request, env }) {
  if (!env.API) return Response.json({ error: 'The app server is not connected yet: add the service binding API → mutos-app in Cloudflare Pages settings.' }, { status: 503 });
  return env.API.fetch(request);
}
