// 'admin' gets the same edit/delete/entity-access reach as 'master' everywhere
// in the app. The one deliberate exception is Settings' user/role management,
// which stays master-only — creating other master/admin accounts is a
// separate security boundary from editing/deleting business records.
export function hasFullAccess(profile) {
  return profile?.role === 'master' || profile?.role === 'admin'
}
