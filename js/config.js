/* ZoneRuns web — public client configuration.
 *
 * Paste the same two values the mobile app uses:
 *   supabaseUrl      EXPO_PUBLIC_SUPABASE_URL       (Supabase dashboard → Project Settings → API → Project URL)
 *   supabaseAnonKey  EXPO_PUBLIC_SUPABASE_ANON_KEY  (the "anon" / publishable key)
 *
 * The anon key is designed to be public (every app build ships it); Row Level Security is what
 * protects the data. NEVER paste the service_role / secret key here — js/account.js refuses to start
 * if it detects one, but it should never be in a public repo at all.
 *
 * While either value is empty, the account features stay hidden and the page is a plain landing page.
 */
window.ZONERUNS_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
