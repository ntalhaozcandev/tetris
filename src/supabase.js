import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Geçersiz anahtarlar durumunda uygulamanın çökmesini engelle
const isConfigured = supabaseUrl && supabaseUrl.startsWith('http') && supabaseAnonKey

export const supabase = isConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null
