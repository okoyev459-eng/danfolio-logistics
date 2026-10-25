// Keke riders sign in with their keke number. Behind the scenes it becomes a
// hidden email. This MUST match the rule in the create-keke Edge Function.
export function kekeEmail(kekeNumber) {
  return kekeNumber.trim().toLowerCase().replace(/[^a-z0-9]/g, '') + '@danfolio.app'
}

// If the person typed an email, use it. Otherwise treat it as a keke number.
export function toLoginEmail(input) {
  return input.includes('@') ? input.trim() : kekeEmail(input)
}
