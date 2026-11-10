const isLocalDevelopment = ['localhost', '127.0.0.1'].includes(window.location.hostname);

window.RISHNOVA_CONFIG = Object.freeze({
  supabaseUrl: 'https://tymorkmzcdsklrybojig.supabase.co',
  // Supabase publishable keys are public; never place a secret or service-role key here.
  supabasePublishableKey: 'sb_publishable_QYkrfqs5lcjNx1yLYAHpgw_Gzap_qiG',
  authRedirectUrl: new URL('/index.html', window.location.origin).toString(),
  backendUrl: isLocalDevelopment ? 'http://127.0.0.1:8000' : ''
});
