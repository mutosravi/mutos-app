// Supabase project for the Muto's app (project "Mutos App") (Project Settings → API Keys).
// This is the PUBLISHABLE key, which is safe in a public page: the privacy rules in the database decide what each login can see.
// Never put the secret key here.
window.MUTOS_CONFIG = {
  supabaseUrl: 'https://plbixpdyxpayyzpzrvna.supabase.co',
  supabaseAnonKey: 'sb_publishable_BBsRicVGu4a7qv0Xv__3cA_5b8DLUQm',
  // public half of the studio's notification key (the private half is a Cloudflare secret)
  vapidPublicKey: '' // phone reminders: set up later with a new key pair
};
