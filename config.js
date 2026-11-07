// Supabase 的 URL 与 publishable/anon key 本来就允许放在网页前端。
// 真正的数据权限由 supabase/schema.sql 中的 RLS 策略保护。
// 绝对不要在这里填写 service_role key。
window.MAOCHUN_CONFIG = {
  supabaseUrl: 'https://fcjrcchddosoqnjggfvf.supabase.co',
  supabaseAnonKey: 'sb_publishable_HPu5J8u05acatb-RkVt5DA_cNZ5OnWY'
};
