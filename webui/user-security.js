(function installUserSecurity(root) {
  'use strict';

  function deleteState(user, currentUserId, usableSuperAdminCount) {
    if (Number(user?.id) === Number(currentUserId)) {
      return { disabled: true, reason: 'self' };
    }
    if (user?.is_usable_super_admin === true && usableSuperAdminCount <= 1) {
      return { disabled: true, reason: 'last_usable_super_admin' };
    }
    return { disabled: false, reason: null };
  }

  root.QQGuardianUserSecurity = Object.freeze({ deleteState });
})(globalThis);
