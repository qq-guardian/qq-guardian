// ─── NapCat NO-AUTH API base ──────────────────────────────────────────────────
// Routes registered via ctx.router.getNoAuth/postNoAuth resolve to this prefix.
// (Authenticated /api/Plugin/ext/... routes require a NapCat session token that
//  this plugin's own page does not carry — see https://napneko.github.io/develop/plugin/start-webui)
const API = '/plugin/napcat-plugin-qq-guardian/api';

// ─── State ───────────────────────────────────────────────────────────────────
let _lang  = localStorage.getItem('lang')  || 'zh';
let _theme = localStorage.getItem('theme') || 'system';
let _currentPage = 'dashboard';

// ─── i18n ────────────────────────────────────────────────────────────────────
const T = {
  zh: {
    // nav
    dashboard:'仪表盘', heroSubtitle:'QQ 群安全守护面板：集中管理入群审批、验证码、风控、黑名单与审计日志。', heroPill:'群安全守护中', approval:'入群审批', punishments:'处罚记录', blacklist:'黑名单',
    risk:'风控规则', audit:'审计日志', monitor:'健康监控', update:'更新', statistics:'统计', settings:'设置', users:'用户管理',
    // users page
    usersTitle:'用户管理', createUserBtn:'+ 新建用户', thId:'ID', thUsername:'用户名', thRole:'角色', thStatus:'状态',
    userRoleSuperAdmin:'超级管理员', userRoleGroupAdmin:'群管理', userRoleAuditor:'审计员', userRoleViewer:'查看者', userRoleMember:'成员',
    userStatusNormal:'正常', userStatusLocked:'已锁定', userUnlockBtn:'解锁', userPasswordBtn:'改密', userDeleteBtn:'删除',
    createUserTitle:'新建用户', editPasswordTitle:'修改密码', usernamePlaceholder:'用户名', passwordPlaceholder:'密码',
    confirmDeleteUser:'确认删除该用户？', userCreated:'用户已创建', userDeleted:'用户已删除', userUpdated:'用户已更新', thPassword:'密码',
    userDeleteSelfDisabled:'不能删除当前登录账户。', userDeleteLastAdminDisabled:'必须保留至少一名未锁定且已设置密码的超级管理员。',
    // common
    approve:'通过', reject:'拒绝', revoke:'撤销', remove:'移除', confirm:'确认', cancel:'取消',
    refresh:'↻ 刷新', punishBtn:'+ 处罚', addBtn:'+ 添加', addRuleBtn:'+ 添加规则', add:'添加',
    // dashboard
    approvalQueue:'审批队列', pendingLabel:'待处理', captchaLabel:'验证码中',
    // approval
    pendingRequests:'待处理请求', noPendingRequests:'暂无待处理请求',
    thUser:'用户', thGroup:'群组', thComment:'验证消息', thStatus:'状态', thTime:'时间', thActions:'操作',
    confirmApprove:'确认通过该申请？', rejectModalTitle:'拒绝申请', rejectReasonLabel:'拒绝原因',
    rejectReasonDefault:'不符合入群要求', approvedMsg:'已通过', rejectedMsg:'已拒绝',
    // punishments
    punishmentsTitle:'处罚记录', noRecords:'暂无记录', thType:'类型', thReason:'原因',
    punishModalTitle:'处罚用户', groupId:'群号', userId:'QQ号', typeLabel:'类型',
    mute:'禁言', kick:'踢出', durationSeconds:'禁言时长（秒，仅禁言）', reasonLabel:'原因',
    doneMsg:'操作完成', confirmRevoke:'确认撤销该处罚？', revokedMsg:'已撤销', revokedBadge:'已撤销',
    // blacklist
    blacklistTitle:'黑名单', blacklistEmpty:'黑名单为空', thAdded:'添加时间',
    blacklistModalTitle:'添加到黑名单', groupIdBlank:'群号（留空 = 全局）', global:'全局',
    addedMsg:'已添加', confirmRemove:'确认从黑名单移除？', removedMsg:'已移除',
    // risk
    riskTitle:'风控规则', noCustomRules:'暂无自定义规则',
    thName:'名称', thPattern:'匹配模式', thRuleAction:'命中动作', thActive:'状态', thOps:'操作',
    ruleModalTitle:'添加风控规则', ruleName:'规则名称', rulePattern:'匹配模式',
    rulePatternPlaceholder:'正则表达式', ruleActionLabel:'命中动作',
    ruleOn:'启用', ruleOff:'停用', enableBtn:'启用', disableBtn:'停用', ruleAddedMsg:'规则已添加',
    // audit
    auditTitle:'审计日志', noLogs:'暂无日志',
    thAction:'操作', thActor:'操作人', thTarget:'目标', systemActor:'系统',
    // monitor
    healthMonitor:'健康监控', noData:'暂无数据',
    // update
    updates:'更新', checking:'检查中…', upToDate:'✅ 当前已是最新版本：v{cur}',
    updateAvailable:'当前版本：v{cur} → 可更新至：v{latest}', installBtn:'安装 v{v}',
    confirmInstall:'确认安装 v{v}？', updateAppliedMsg:'更新已应用，请重启',
    // statistics
    statisticsTitle:'统计', totalApprovals:'审批总数', approvedStat:'已通过', rejectedStat:'已拒绝',
    punishmentsStat:'处罚总数', riskDetections:'风险检测', captchasOk:'验证码通过',
    trendTitle:'近 30 天趋势', trendApprovals:'审批', trendRisk:'风险检测', trendPunish:'处罚',
    trendTableToggle:'查看数据表', thDate:'日期', trendEmpty:'暂无统计数据',
    // settings
    settingsTitle:'设置', botSelfId:'机器人 QQ 号',
    notifyAdmin:'通知管理员', logOnly:'仅记录', offAction:'关闭', saveSettings:'保存设置', settingsSavedMsg:'设置已保存',
    detectorActionsLabel:'检测器与处理动作',
    detectorActionsHint:'每类检测器直接指定命中后的处理动作；多类同时命中时执行最严厉的动作（踢出 > 禁言 > 通知管理员 > 仅记录）。累犯会按处罚升级设置自动加重。',
    muteDurationLabel:'风险禁言时长（秒）',
    aiMinScoreLabel:'AI 判定阈值（0-100）', aiMinScoreHint:'仅用于"AI 智能识别"：AI 返回分数达到此值视为命中。',
    det_advertising:'广告推广', det_fraud:'诈骗', det_grayMarket:'灰产', det_pornography:'色情',
    det_political:'政治敏感', det_gambling:'赌博', det_shortLinks:'短链接', det_duplicateMessages:'高频刷屏',
    det_spam:'重复内容', det_cardMessage:'富媒体卡片', det_aiViolation:'AI 智能识别',
    recallLabel:'撤回违规消息', recallHint:'检测到风险消息时同时撤回该消息（附加于风险处理动作之上，机器人需为群管理员）。',
    builtinRejectLabel:'启用内置入群拒绝关键词', builtinRejectHint:'入群申请附言命中内置的广告/刷单/诈骗/引流等特征时立即自动拒绝（在各群自定义拒绝关键词之外生效）。',
    builtinApproveLabel:'启用高风险内置通过话术', builtinApproveHint:'警告：申请人可伪造“朋友推荐”等话术。启用后，人工审核群中的匹配申请会绕过人工确认并自动通过。默认关闭；建议使用每群自定义可信规则。',
    confirmBuiltinApprove:'此选项会让申请人填写的通用推荐话术绕过人工审核。确认接受此风险并启用？',
    intelEnabledLabel:'启用远端风控 Feed', intelEnabledHint:'启用后默认仅观察，不执行远端审核或处罚。执行动作还需要超级管理员为每个 Feed 固定 SHA-256，并在高级配置中选择 enforce。',
    commandsEnabledLabel:'启用群内指令', commandPrefixLabel:'指令前缀',
    commandsHint:'群主/管理员可在群内发送指令，如 /guard mute @某人 10。发送 /guard help 查看全部指令。',
    timezoneLabel:'时区（宵禁等定时功能）', timezoneHint:'IANA 时区名称，如 Asia/Shanghai。宵禁时间按此时区解释，而不是服务器本地时间。',
    githubRepoLabel:'GitHub 仓库（更新检查）', githubRepoHint:'格式：用户名/仓库名。修改后指向你自己的仓库才能检查到你发布的新版本。',
    viewReleaseBtn:'在 GitHub 查看', noBuildAssetMsg:'此版本未附带构建包',
    manageVersionsBtn:'版本管理', versionModalTitle:'版本管理',
    currentVersionLabel:'当前版本', repoLabel:'仓库',
    stableTab:'正式版本', prereleaseTab:'预发布版本',
    searchVersionPlaceholder:'搜索版本号...', totalVersionsLabel:'共 {n} 个版本',
    noVersionsFound:'未找到匹配的版本', currentBadge:'当前', downgradeBadge:'降级',
    updateToThisVersionBtn:'更新到此版本',
    // groups
    groups:'群组管理', groupsTitle:'群组管理', refreshGroups:'↻ 刷新群列表',
    botAccount:'机器人账号', loadingBotInfo:'加载中…', fetchBotFailed:'获取机器人信息失败',
    thGroupName:'群名称', thMembers:'成员数', thApprovalAction:'入群处理',
    colProtection:'防护', colReminder:'提醒',
    saveAllGroupsBtn:'💾 保存设置', saveAllGroupsHint:'修改开关或入群处理方式后，点击此按钮统一保存，未保存的修改不会生效。',
    keywordRulesBtn:'群规则', keywordModalTitle:'群规则设置',
    approveKeywordsLabel:'通过关键词（每行一个）', rejectKeywordsLabel:'拒绝关键词（每行一个）',
    keywordsPlaceholder:'例如：\n开源贡献\n项目合作',
    approveKeywordsHint:'入群申请理由包含以上任意关键词时，自动通过（优先于该群的入群处理方式）。',
    rejectKeywordsHint:'入群申请理由包含以上任意关键词时，自动拒绝（优先级高于通过关键词）。',
    welcomeEnabledLabel:'欢迎新成员', welcomeTemplateLabel:'欢迎语模板',
    welcomeTemplateHint:'占位符：{user} 变成 @新成员，{group} 变成群名称。留空使用默认欢迎语。',
    curfewEnabledLabel:'宵禁（定时全群禁言）', curfewStartLabel:'宵禁开始', curfewEndLabel:'宵禁结束',
    curfewHint:'在设定时间段内自动全群禁言，结束后自动解除。可跨午夜（如 23:00 → 07:00）。时间按设置页的时区解释。',
    groupsConfigAppliedMsg:'配置已保存成功', groupsConfigPartialFailMsg:'部分群组保存失败',
    manualReview:'人工审核', autoApprove:'自动通过', autoReject:'自动拒绝', captchaAction:'验证码',
    groupSavedMsg:'已保存', noGroups:'机器人未加入任何群聊',
  },
  en: {
    dashboard:'Dashboard', heroSubtitle:'QQ group protection panel: approvals, captcha, risk control, blacklist, and audit management in one place.', heroPill:'Group protection online', approval:'Approval', punishments:'Punishments', blacklist:'Blacklist',
    risk:'Risk Rules', audit:'Audit Log', monitor:'Monitor', update:'Update', statistics:'Statistics', settings:'Settings',
    approve:'Approve', reject:'Reject', revoke:'Revoke', remove:'Remove', confirm:'Confirm', cancel:'Cancel',
    refresh:'↻ Refresh', punishBtn:'+ Punish', addBtn:'+ Add', addRuleBtn:'+ Add Rule', add:'Add',
    approvalQueue:'Approval Queue', pendingLabel:'Pending', captchaLabel:'Captcha',
    pendingRequests:'Pending Requests', noPendingRequests:'No pending requests',
    thUser:'User', thGroup:'Group', thComment:'Comment', thStatus:'Status', thTime:'Time', thActions:'Actions',
    confirmApprove:'Approve this request?', rejectModalTitle:'Reject Request', rejectReasonLabel:'Reason',
    rejectReasonDefault:'Does not meet requirements', approvedMsg:'Approved', rejectedMsg:'Rejected',
    punishmentsTitle:'Punishments', noRecords:'No records', thType:'Type', thReason:'Reason',
    punishModalTitle:'Punish User', groupId:'Group ID', userId:'User ID', typeLabel:'Type',
    mute:'Mute', kick:'Kick', durationSeconds:'Duration (seconds, mute only)', reasonLabel:'Reason',
    doneMsg:'Done', confirmRevoke:'Revoke this punishment?', revokedMsg:'Revoked', revokedBadge:'revoked',
    blacklistTitle:'Blacklist', blacklistEmpty:'Blacklist is empty', thAdded:'Added',
    blacklistModalTitle:'Add to Blacklist', groupIdBlank:'Group ID (blank = global)', global:'Global',
    addedMsg:'Added', confirmRemove:'Remove from blacklist?', removedMsg:'Removed',
    riskTitle:'Risk Rules', noCustomRules:'No custom rules',
    thName:'Name', thPattern:'Pattern', thRuleAction:'Action', thActive:'Active', thOps:'Ops',
    ruleModalTitle:'Add Risk Rule', ruleName:'Name', rulePattern:'Pattern',
    rulePatternPlaceholder:'regex', ruleActionLabel:'Action on match',
    ruleOn:'on', ruleOff:'off', enableBtn:'Enable', disableBtn:'Disable', ruleAddedMsg:'Rule added',
    auditTitle:'Audit Logs', noLogs:'No logs',
    thAction:'Action', thActor:'Actor', thTarget:'Target', systemActor:'system',
    healthMonitor:'Health Monitor', noData:'No data',
    updates:'Updates', checking:'Checking…', upToDate:'✅ Up to date: v{cur}',
    updateAvailable:'Current: v{cur} → Available: v{latest}', installBtn:'Install v{v}',
    confirmInstall:'Install v{v}?', updateAppliedMsg:'Update applied, please restart',
    statisticsTitle:'Statistics', totalApprovals:'Total Approvals', approvedStat:'Approved', rejectedStat:'Rejected',
    punishmentsStat:'Punishments', riskDetections:'Risk Detections', captchasOk:'Captchas OK',
    trendTitle:'30-Day Trend', trendApprovals:'Approvals', trendRisk:'Risk Detections', trendPunish:'Punishments',
    trendTableToggle:'View data table', thDate:'Date', trendEmpty:'No statistics yet',
    settingsTitle:'Settings', botSelfId:'Bot Self ID',
    notifyAdmin:'Notify Admin', logOnly:'Log Only', offAction:'Off', saveSettings:'Save Settings', settingsSavedMsg:'Settings saved',
    detectorActionsLabel:'Detectors & Actions',
    detectorActionsHint:'Each detector maps directly to its action; when several match one message, the most severe wins (Kick > Mute > Notify > Log). Repeat offenders escalate via the punishment settings.',
    muteDurationLabel:'Risk mute duration (seconds)',
    aiMinScoreLabel:'AI score cutoff (0-100)', aiMinScoreHint:'Only for the AI detector: an AI result at or above this counts as a hit.',
    det_advertising:'Advertising', det_fraud:'Fraud', det_grayMarket:'Gray market', det_pornography:'Pornography',
    det_political:'Political', det_gambling:'Gambling', det_shortLinks:'Short links', det_duplicateMessages:'Message flood',
    det_spam:'Repeated content', det_cardMessage:'Rich-media cards', det_aiViolation:'AI analysis',
    recallLabel:'Recall Risky Messages', recallHint:'Also delete the offending message when risk is detected (in addition to the risk action; the bot must be a group admin).',
    builtinRejectLabel:'Built-in Join-request Reject Keywords', builtinRejectHint:'Instantly auto-reject join applications whose comment matches the built-in ad/spam/fraud patterns (applies on top of each group\'s own reject keywords).',
    builtinApproveLabel:'Enable High-risk Referral Heuristic', builtinApproveHint:'Warning: applicants can forge generic referral claims. Matching requests in manual-review groups will bypass human confirmation and be auto-approved. Off by default; prefer trusted per-group rules.',
    confirmBuiltinApprove:'This lets applicant-controlled referral text bypass manual review. Confirm that you accept this risk and want to enable it?',
    intelEnabledLabel:'Enable Remote Risk Feed', intelEnabledHint:'Enabled feeds observe only by default. Remote admission or moderation actions additionally require a super-admin to pin every feed SHA-256 and select enforce in advanced configuration.',
    commandsEnabledLabel:'Enable In-chat Commands', commandPrefixLabel:'Command Prefix',
    commandsHint:'Group owners/admins can moderate via chat, e.g. /guard mute @user 10. Send /guard help for all commands.',
    timezoneLabel:'Timezone (curfew & schedules)', timezoneHint:'IANA timezone name, e.g. Asia/Shanghai. Curfew times are interpreted in this timezone, not server-local time.',
    githubRepoLabel:'GitHub Repo (for update checks)', githubRepoHint:'Format: owner/repo. Point this at your own fork to detect your own releases.',
    viewReleaseBtn:'View on GitHub', noBuildAssetMsg:'No build asset attached to this release',
    manageVersionsBtn:'Manage Versions', versionModalTitle:'Version Management',
    currentVersionLabel:'Current Version', repoLabel:'Repository',
    stableTab:'Stable', prereleaseTab:'Pre-release',
    searchVersionPlaceholder:'Search version...', totalVersionsLabel:'{n} versions total',
    noVersionsFound:'No matching versions found', currentBadge:'Current', downgradeBadge:'Downgrade',
    updateToThisVersionBtn:'Update to this version',
    // groups
    groups:'Groups', groupsTitle:'Group Management', refreshGroups:'↻ Refresh Groups',
    botAccount:'Bot Account', loadingBotInfo:'Loading…', fetchBotFailed:'Failed to fetch bot info',
    thGroupName:'Group Name', thMembers:'Members', thApprovalAction:'Join Handling',
    colProtection:'Protection', colReminder:'Reminders',
    saveAllGroupsBtn:'💾 Save Settings', saveAllGroupsHint:'Toggle switches or change join handling, then click here to save all changes at once. Unsaved changes have no effect.',
    keywordRulesBtn:'Group Rules', keywordModalTitle:'Group Rules',
    welcomeEnabledLabel:'Welcome new members', welcomeTemplateLabel:'Welcome template',
    welcomeTemplateHint:'Placeholders: {user} becomes an @-mention of the new member, {group} becomes the group name. Empty = built-in default.',
    curfewEnabledLabel:'Curfew (scheduled whole-group mute)', curfewStartLabel:'Curfew start', curfewEndLabel:'Curfew end',
    curfewHint:'Automatically mutes the whole group inside the window and unmutes after. May wrap past midnight (e.g. 23:00 → 07:00). Times use the timezone from Settings.',
    approveKeywordsLabel:'Approve Keywords (one per line)', rejectKeywordsLabel:'Reject Keywords (one per line)',
    keywordsPlaceholder:'e.g.\nopen source contributor\nproject collaboration',
    approveKeywordsHint:'If the join request comment contains any of these, it is auto-approved (overrides this group\u2019s normal join-handling mode).',
    rejectKeywordsHint:'If the join request comment contains any of these, it is auto-rejected (checked before — and takes priority over — approve keywords).',
    groupsConfigAppliedMsg:'Configuration applied successfully', groupsConfigPartialFailMsg:'Some groups failed to save',
    manualReview:'Manual review', autoApprove:'Auto-approve', autoReject:'Auto-reject', captchaAction:'Captcha',
    groupSavedMsg:'Saved', noGroups:'Bot is not in any groups',
    users:'Users', usersTitle:'User Management', createUserBtn:'+ Create User',
    thId:'ID', thUsername:'Username', thRole:'Role', thStatus:'Status', thPassword:'Password',
    userRoleSuperAdmin:'Super Admin', userRoleGroupAdmin:'Group Admin', userRoleAuditor:'Auditor', userRoleViewer:'Viewer', userRoleMember:'Member',
    userStatusNormal:'Normal', userStatusLocked:'Locked', userUnlockBtn:'Unlock', userPasswordBtn:'Password', userDeleteBtn:'Delete',
    createUserTitle:'Create User', editPasswordTitle:'Change Password', usernamePlaceholder:'Username', passwordPlaceholder:'Password',
    confirmDeleteUser:'Delete this user?', userCreated:'User created', userDeleted:'User deleted', userUpdated:'User updated',
    userDeleteSelfDisabled:'The currently signed-in account cannot be deleted.', userDeleteLastAdminDisabled:'At least one unlocked, password-enabled super administrator must remain.',
  },
};
const t = (k, vars) => {
  let s = T[_lang][k] ?? k;
  if (vars) for (const [key, val] of Object.entries(vars)) s = s.replace(`{${key}}`, val);
  return s;
};

const PAGES = [
  {id:'dashboard',icon:'📊'},{id:'groups',icon:'👥'},{id:'approval',icon:'✅'},{id:'punishments',icon:'🔨'},
  {id:'blacklist',icon:'⛔'},{id:'risk',icon:'⚠️'},{id:'audit',icon:'📋'},
  {id:'monitor',icon:'💓'},{id:'update',icon:'🔄'},{id:'statistics',icon:'📈'},{id:'settings',icon:'⚙️'},{id:'users',icon:'👤'},
];

// Apply translations to every static [data-t] element in the document
function applyI18n() {
  document.documentElement.lang = _lang;
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
}

// ─── Theme / lang ────────────────────────────────────────────────────────────
document.getElementById('theme-btn').onclick = () => {
  _theme = {light:'dark',dark:'system',system:'light'}[_theme] || 'system';
  document.documentElement.dataset.theme = _theme;
  localStorage.setItem('theme', _theme);
};
document.getElementById('lang-btn').onclick = () => {
  _lang = _lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('lang', _lang);
  document.getElementById('lang-btn').textContent = _lang === 'zh' ? 'EN' : '中文';
  applyI18n(); buildNav(); navigateTo(_currentPage);
};
document.getElementById('lang-btn').textContent = _lang === 'zh' ? 'EN' : '中文';
document.documentElement.dataset.theme = _theme;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $ = s => document.querySelector(s);
function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3500);
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
function statusBadge(s) {
  const m = {approved:'green',rejected:'red',pending:'yellow',captcha:'blue',expired:'gray'};
  return `<span class="badge badge-${m[s]||'gray'}">${s}</span>`;
}
/** Escape user/server-controlled strings before injecting into innerHTML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

// ─── Auth state (access token kept in-memory; refresh token in sessionStorage)
let _accessToken = null;
let _currentRole = 'viewer'; // decoded from JWT after login/refresh
function parseJwtRole(token) {
  try { return JSON.parse(atob(token.split('.')[1])).role ?? 'viewer'; } catch { return 'viewer'; }
}
const SK_REFRESH = 'qqg_refresh';

function showLoginOverlay(errMsg='') {
  $('#login-err').textContent = errMsg;
  $('#login-overlay').classList.add('open');
  $('#login-pass').value = '';
  setTimeout(() => $('#login-pass').focus(), 50);
}
function hideLoginOverlay() { $('#login-overlay').classList.remove('open'); }

window.doLogin = async () => {
  const user = $('#login-user').value.trim();
  const pass = $('#login-pass').value;
  $('#login-btn').disabled = true;
  try {
    const res = await fetch(API + '/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username:user, password:pass}),
    });
    const json = await res.json().catch(()=>({}));
    if (!res.ok || json.code !== 0) { showLoginOverlay(json.message || '登录失败 Login failed'); return; }
    _accessToken = json.data.accessToken;
    _currentRole = parseJwtRole(_accessToken);
    if (json.data.refreshToken) sessionStorage.setItem(SK_REFRESH, json.data.refreshToken);
    hideLoginOverlay();
    buildNav(); loadPage(_currentPage); onAuthReady();
  } catch(e) { showLoginOverlay(e.message); }
  finally { $('#login-btn').disabled = false; }
};
$('#login-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

let _refreshInFlight = null;
function tryRefresh() {
  // Single-flight: refresh tokens are one-time-use server-side, so two
  // overlapping 401s must await the SAME rotation instead of racing it.
  _refreshInFlight ??= doRefresh().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}
async function doRefresh() {
  const rt = sessionStorage.getItem(SK_REFRESH);
  if (!rt) return false;
  try {
    const res = await fetch(API + '/auth/refresh', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({refreshToken: rt}),
    });
    const json = await res.json().catch(()=>({}));
    if (!res.ok || json.code !== 0) { sessionStorage.removeItem(SK_REFRESH); return false; }
    _accessToken = json.data.accessToken;
    _currentRole = parseJwtRole(_accessToken);
    // Server rotates the refresh token on every use — store the new one.
    if (json.data.refreshToken) sessionStorage.setItem(SK_REFRESH, json.data.refreshToken);
    else sessionStorage.removeItem(SK_REFRESH);
    return true;
  } catch { return false; }
}

async function initAuth() {
  if (sessionStorage.getItem(SK_REFRESH)) {
    const ok = await tryRefresh();
    if (ok) { hideLoginOverlay(); buildNav(); navigateTo(_currentPage); onAuthReady(); return; }
  }
  showLoginOverlay();
}

async function api(path, opts={}) {
  const headers = {'Content-Type':'application/json'};
  if (_accessToken) headers['Authorization'] = 'Bearer ' + _accessToken;
  const res = await fetch(API + path, {
    ...opts, headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) return api(path, opts); // retry once with new token
    showLoginOverlay('会话已过期，请重新登录 / Session expired');
    throw new Error('Unauthorized');
  }
  const json = await res.json().catch(()=>({}));
  if (!res.ok || json.code !== 0) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data;
}
function openModal(title, bodyHTML, buttons) {
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = bodyHTML;
  $('#modal-footer').innerHTML = '';
  for (const btn of buttons) {
    const el = document.createElement('button');
    el.className = 'btn ' + (btn.cls||'btn-outline'); el.textContent = btn.label;
    el.onclick = btn.onClick; $('#modal-footer').appendChild(el);
  }
  $('#modal-overlay').classList.add('open');
}
function closeModal() { $('#modal-overlay').classList.remove('open'); }
$('#modal-overlay').onclick = e => { if(e.target===$('#modal-overlay')) closeModal(); };

// ─── Navigation ───────────────────────────────────────────────────────────────
function buildNav() {
  const nav = $('#sb-nav'); nav.innerHTML = '';
  const visiblePages = PAGES.filter(p => p.id !== 'users' || _currentRole === 'super_admin');
  for (const p of visiblePages) {
    const el = document.createElement('div');
    el.className = 'sb-item' + (p.id===_currentPage?' active':'');
    el.dataset.page = p.id;
    el.innerHTML = `<span>${p.icon}</span><span>${t(p.id)}</span>`;
    el.onclick = () => navigateTo(p.id); nav.appendChild(el);
  }
}
function navigateTo(id) {
  _currentPage = id;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const pg = document.getElementById('page-'+id);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(el=>el.classList.toggle('active',el.dataset.page===id));
  $('#page-title').textContent = t(id);
  loadPage(id);
}

// ─── Page loaders ─────────────────────────────────────────────────────────────
async function loadPage(id) {
  try {
    if(id==='dashboard')  await loadDashboard();
    if(id==='groups')     await loadGroups();
    if(id==='approval')   await loadApprovals();
    if(id==='punishments')await loadPunishments();
    if(id==='blacklist')  await loadBlacklist();
    if(id==='risk')       await loadRisk();
    if(id==='audit')      await loadAudit();
    if(id==='monitor')    await loadMonitor();
    if(id==='update')     await loadUpdate();
    if(id==='statistics') await loadStatistics();
    if(id==='settings')   await loadSettings();
    if(id==='users')      await loadUsers();
  } catch(e) { toast(e.message,'error'); }
}

async function loadDashboard() {
  const s = await api('/stats');
  const t_ = s.totals;
  $('#stats-grid').innerHTML = [
    {v:t_.approvals_total,l:t('totalApprovals')},{v:t_.approvals_passed,l:t('approvedStat')},
    {v:t_.approvals_rejected,l:t('rejectedStat')},{v:t_.punishments_total,l:t('punishmentsStat')},
    {v:t_.risk_detections,l:t('riskDetections')},{v:t_.captchas_passed,l:t('captchasOk')},
  ].map(x=>`<div class="stat-card"><div class="stat-val">${x.v}</div><div class="stat-label">${x.l}</div></div>`).join('');
  const pending = s.approvalCounts?.pending ?? 0, captcha = s.approvalCounts?.captcha ?? 0;
  $('#dash-pending').innerHTML = `<span class="badge badge-yellow">${t('pendingLabel')}: ${pending}</span>&nbsp;<span class="badge badge-blue">${t('captchaLabel')}: ${captcha}</span>`;
}

// ─── Groups page: prerequisite bot account fetch, then live group list ────────
// ─── Groups page ────────────────────────────────────────────────────────────
// Two simplified switches per group, mapped onto the backend's more granular
// fields:
//   protection_enabled (UI) → enabled + riskEnabled + autoKickBlacklisted (all three kept in sync)
//   reminder_enabled   (UI) → notifyOnRisk + notifyOnJoin (kept in sync)
// Checkboxes never write to the backend on change — they only hold PENDING,
// in-memory UI state (plain DOM .checked booleans) until the single
// "Save Settings" button at the bottom is clicked, per spec.
const ACTION_LABEL_KEY = { manual:'manualReview', auto_approve:'autoApprove', auto_reject:'autoReject', captcha:'captchaAction' };
let _loadedGroups = []; // cache of the last /groups response, for the keyword-rules modal lookup

async function loadGroups() {
  const card = $('#bot-account-card');
  card.textContent = t('loadingBotInfo');
  try {
    const bot = await api('/bot/info');
    card.innerHTML = `<div class="card-title" data-t="botAccount">${t('botAccount')}</div>
      <div style="font-size:14px">🤖 <strong>${esc(bot.nickname)||'-'}</strong> &nbsp; QQ: ${bot.user_id}</div>`;
  } catch(e) {
    card.innerHTML = `<div class="card-title" data-t="botAccount">${t('botAccount')}</div><div class="empty">${t('fetchBotFailed')}: ${esc(e.message)}</div>`;
  }

  const tb = $('#groups-tbody');
  tb.innerHTML = `<tr><td colspan="5" class="empty">${t('loadingBotInfo')}</td></tr>`;
  let groups;
  try { groups = await api('/groups'); }
  catch(e) { tb.innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`; return; }

  if (!groups.length) { tb.innerHTML = `<tr><td colspan="5" class="empty">${t('noGroups')}</td></tr>`; return; }
  _loadedGroups = groups;

  tb.innerHTML = groups.map(g => {
    const gid = g.group_id;
    // Strict boolean display: a real JS boolean drives the checkbox, never a string.
    const protectionOn = g.enabled === true;
    const reminderOn   = (g.notifyOnRisk === true) || (g.notifyOnJoin === true);
    const kwCount = (g.approveKeywords?.length||0) + (g.rejectKeywords?.length||0);
    return `<tr data-gid="${gid}">
      <td><strong>${esc(g.group_name)||('#'+gid)}</strong><div style="font-size:11px;color:var(--muted)">${gid}</div></td>
      <td>${esc(g.member_count)}${g.max_member_count?'/'+esc(g.max_member_count):''}</td>
      <td><label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" class="g-protection" ${protectionOn?'checked':''}/> ${t('colProtection')}</label></td>
      <td><label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" class="g-reminder" ${reminderOn?'checked':''}/> ${t('colReminder')}</label></td>
      <td>
        <select class="g-action" style="min-width:120px">
          ${Object.entries(ACTION_LABEL_KEY).map(([v,k])=>`<option value="${v}" ${g.action===v?'selected':''}>${t(k)}</option>`).join('')}
        </select>
        <button class="btn btn-outline btn-sm" style="margin-top:6px" data-keyword-gid="${gid}">⚙️ ${t('keywordRulesBtn')}${kwCount?` (${kwCount})`:''}</button>
      </td>
    </tr>`;
  }).join('');
}

// ─── Keyword-based join approval (restored) ────────────────────────────────
// A join request whose comment matches an approve-keyword is auto-approved;
// a match against a reject-keyword is auto-rejected — independent of, and
// checked BEFORE, the group's general approval mode. Saved immediately via
// its own request (not the unified toggle Save Settings button), and never
// touches that group's toggle/action state — see the backend's per-field
// preserve-if-absent handling in POST /groups/:groupId.
window.openKeywordModal = (gid) => {
  const g = _loadedGroups.find(x => x.group_id === gid) || {};
  openModal(`${t('keywordModalTitle')} — ${g.group_name||('#'+gid)}`, `
    <div class="form-group"><label>${t('approveKeywordsLabel')}</label>
      <textarea id="kw-approve" rows="4" placeholder="${t('keywordsPlaceholder')}">${esc((g.approveKeywords||[]).join('\n'))}</textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${t('approveKeywordsHint')}</div></div>
    <div class="form-group"><label>${t('rejectKeywordsLabel')}</label>
      <textarea id="kw-reject" rows="4" placeholder="${t('keywordsPlaceholder')}">${esc((g.rejectKeywords||[]).join('\n'))}</textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${t('rejectKeywordsHint')}</div></div>
    <hr>
    <div class="form-group">
      <label style="display:inline-flex;align-items:center;gap:8px"><input type="checkbox" id="gr-welcome" style="width:auto" ${g.welcomeEnabled===true?'checked':''}/> ${t('welcomeEnabledLabel')}</label>
    </div>
    <div class="form-group"><label>${t('welcomeTemplateLabel')}</label>
      <textarea id="gr-welcome-tpl" rows="2" maxlength="500" placeholder="👋 欢迎 {user} 加入 {group}！">${esc(g.welcomeTemplate||'')}</textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${t('welcomeTemplateHint')}</div></div>
    <hr>
    <div class="form-group">
      <label style="display:inline-flex;align-items:center;gap:8px"><input type="checkbox" id="gr-curfew" style="width:auto" ${g.curfewEnabled===true?'checked':''}/> ${t('curfewEnabledLabel')}</label>
    </div>
    <div style="display:flex;gap:12px">
      <div class="form-group" style="flex:1"><label>${t('curfewStartLabel')}</label><input type="time" id="gr-curfew-start" value="${esc(g.curfewStart||'23:00')}"/></div>
      <div class="form-group" style="flex:1"><label>${t('curfewEndLabel')}</label><input type="time" id="gr-curfew-end" value="${esc(g.curfewEnd||'07:00')}"/></div>
    </div>
    <div style="font-size:12px;color:var(--muted)">${t('curfewHint')}</div>
  `, [
    { label: t('cancel'), onClick: closeModal },
    { label: t('saveSettings'), cls: 'btn-primary', onClick: async () => {
        const split = v => v.split('\n').map(s => s.trim()).filter(Boolean);
        try {
          await api(`/groups/${gid}`, { method:'POST', body: {
            approveKeywords: split($('#kw-approve').value),
            rejectKeywords:  split($('#kw-reject').value),
            welcomeEnabled:  $('#gr-welcome').checked === true,
            welcomeTemplate: $('#gr-welcome-tpl').value,
            curfewEnabled:   $('#gr-curfew').checked === true,
            curfewStart:     $('#gr-curfew-start').value || '23:00',
            curfewEnd:       $('#gr-curfew-end').value || '07:00',
          }});
          closeModal();
          toast(t('groupsConfigAppliedMsg'), 'success');
          await loadGroups();
        } catch(e) { toast(e.message, 'error'); }
      } },
  ]);
};

// Refresh = re-run the FULL sequenced bootstrap (bot info → group list → merge),
// not just a cached re-read — for when the bot has joined/left groups since boot.
window.refreshGroups = async () => {
  try { await api('/groups/refresh', { method: 'POST' }); await loadGroups(); toast(t('groupSavedMsg'), 'success'); }
  catch(e) { toast(e.message, 'error'); }
};

// Unified save: read every row's CURRENT (pending, unsaved) checkbox/select
// state, validate it is a strict boolean, and persist all rows together.
// Nothing is written until this is called.
window.saveAllGroups = async () => {
  const rows = [...document.querySelectorAll('#groups-tbody tr[data-gid]')];
  if (!rows.length) return;

  const updates = rows.map(row => {
    const gid = row.dataset.gid;
    // .checked is ALWAYS a native boolean in the DOM — never a string "true"/"false".
    const protectionEnabled = row.querySelector('.g-protection').checked === true;
    const reminderEnabled   = row.querySelector('.g-reminder').checked === true;
    const action            = row.querySelector('.g-action').value;
    return {
      groupId: gid,
      body: {
        enabled:             protectionEnabled,
        riskEnabled:         protectionEnabled,
        autoKickBlacklisted: protectionEnabled,
        notifyOnRisk:        reminderEnabled,
        notifyOnJoin:        reminderEnabled,
        action,
      },
    };
  });

  const results = await Promise.allSettled(
    updates.map(u => api(`/groups/${u.groupId}`, { method: 'POST', body: u.body }))
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed === 0) toast(t('groupsConfigAppliedMsg'), 'success');
  else toast(`${t('groupsConfigPartialFailMsg')} (${failed}/${updates.length})`, 'error');
};

async function loadApprovals() {
  const data = await api('/approvals?limit=100');
  const tb = $('#approval-tbody');
  if (!data.length) { tb.innerHTML = `<tr><td colspan="6" class="empty">${t('noPendingRequests')}</td></tr>`; return; }
  tb.innerHTML = data.map(r=>`<tr>
    <td>${esc(r.user_id)}</td><td>${esc(r.group_id)}</td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.comment)||'—'}</td>
    <td>${statusBadge(r.status)}</td><td>${fmtTime(r.created_at)}</td>
    <td>${r.status==='pending'||r.status==='captcha'?`
      <button class="btn btn-outline btn-sm" data-approve-id="${esc(r.id)}">${t('approve')}</button>
      <button class="btn btn-danger btn-sm" data-reject-id="${esc(r.id)}">${t('reject')}</button>`:'-'}</td>
  </tr>`).join('');
}
window.approveReq = async id => {
  if(!confirm(t('confirmApprove'))) return;
  try { await api(`/approvals/${id}/approve`,{method:'POST',body:{operatorId:0}}); toast(t('approvedMsg'),'success'); loadApprovals(); } catch(e){toast(e.message,'error');}
};
window.rejectReq = id => openModal(t('rejectModalTitle'),
  `<div class="form-group"><label>${t('rejectReasonLabel')}</label><input id="rr" type="text" value="${t('rejectReasonDefault')}"/></div>`,
  [{label:t('cancel'),onClick:closeModal},{label:t('reject'),cls:'btn-danger',onClick:async()=>{
    try{await api(`/approvals/${id}/reject`,{method:'POST',body:{operatorId:0,reason:$('#rr').value}});closeModal();toast(t('rejectedMsg'),'success');loadApprovals();}catch(e){toast(e.message,'error');}
  }}]);

async function loadPunishments() {
  const data = await api('/punishments?limit=100');
  const tb = $('#punishments-tbody');
  if(!data.length){tb.innerHTML=`<tr><td colspan="6" class="empty">${t('noRecords')}</td></tr>`;return;}
  tb.innerHTML=data.map(r=>`<tr>
    <td>${esc(r.user_id)}</td><td>${esc(r.group_id)}</td>
    <td><span class="badge badge-${r.type==='mute'?'yellow':'red'}">${r.type==='mute'?t('mute'):t('kick')}</span></td>
    <td>${esc(r.reason)||'—'}</td><td>${fmtTime(r.created_at)}</td>
    <td>${!r.revoked_at?`<button class="btn btn-outline btn-sm" data-revoke-id="${esc(r.id)}">${t('revoke')}</button>`:`<span class="badge badge-gray">${t('revokedBadge')}</span>`}</td>
  </tr>`).join('');
}
window.openPunishModal = () => openModal(t('punishModalTitle'),`
  <div class="form-group"><label>${t('groupId')}</label><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="p-gid"/></div>
  <div class="form-group"><label>${t('userId')}</label><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="p-uid"/></div>
  <div class="form-group"><label>${t('typeLabel')}</label><select id="p-type"><option value="mute">${t('mute')}</option><option value="kick">${t('kick')}</option></select></div>
  <div class="form-group"><label>${t('durationSeconds')}</label><input type="number" id="p-dur" value="600"/></div>
  <div class="form-group"><label>${t('reasonLabel')}</label><input type="text" id="p-reason"/></div>`,
  [{label:t('cancel'),onClick:closeModal},{label:t('punishBtn').replace('+ ',''),cls:'btn-danger',onClick:async()=>{
    const type=$('#p-type').value;
    try{
      if(type==='mute') await api('/punishments/mute',{method:'POST',body:{groupId:$('#p-gid').value,userId:$('#p-uid').value,durationSeconds:$('#p-dur').value,reason:$('#p-reason').value,operatorId:0}});
      else await api('/punishments/kick',{method:'POST',body:{groupId:$('#p-gid').value,userId:$('#p-uid').value,reason:$('#p-reason').value,operatorId:0}});
      closeModal();toast(t('doneMsg'),'success');loadPunishments();
    }catch(e){toast(e.message,'error');}
  }}]);
window.revokePunishment = async id=>{
  if(!confirm(t('confirmRevoke')))return;
  try{await api(`/punishments/${id}/revoke`,{method:'POST',body:{operatorId:0}});toast(t('revokedMsg'),'success');loadPunishments();}catch(e){toast(e.message,'error');}
};

async function loadBlacklist() {
  const data = await api('/blacklist?limit=100');
  const tb = $('#blacklist-tbody');
  if(!data.length){tb.innerHTML=`<tr><td colspan="5" class="empty">${t('blacklistEmpty')}</td></tr>`;return;}
  tb.innerHTML=data.map(r=>`<tr>
    <td>${r.user_id}</td><td>${r.group_id||`<span class="badge badge-red">${t('global')}</span>`}</td>
    <td>${esc(r.reason)||'—'}</td><td>${fmtTime(r.created_at)}</td>
    <td><button class="btn btn-danger btn-sm" data-bl-uid="${r.user_id}" data-bl-gid="${r.group_id||''}">${t('remove')}</button></td>
  </tr>`).join('');
}
window.openBlacklistModal = () => openModal(t('blacklistModalTitle'),`
  <div class="form-group"><label>${t('userId')}</label><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="bl-uid"/></div>
  <div class="form-group"><label>${t('groupIdBlank')}</label><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="bl-gid"/></div>
  <div class="form-group"><label>${t('reasonLabel')}</label><input type="text" id="bl-reason"/></div>`,
  [{label:t('cancel'),onClick:closeModal},{label:t('add'),cls:'btn-danger',onClick:async()=>{
    try{await api('/blacklist',{method:'POST',body:{userId:$('#bl-uid').value,groupId:$('#bl-gid').value||null,reason:$('#bl-reason').value}});closeModal();toast(t('addedMsg'),'success');loadBlacklist();}catch(e){toast(e.message,'error');}
  }}]);
window.removeBlacklist = async(uid,gid)=>{
  if(!confirm(t('confirmRemove')))return;
  try{await api(`/blacklist/${encodeURIComponent(uid)}${gid&&gid!='null'?'?groupId='+encodeURIComponent(gid):''}`,{method:'DELETE'});toast(t('removedMsg'),'success');loadBlacklist();}catch(e){toast(e.message,'error');}
};

async function loadRisk() {
  const data = await api('/risk/rules');
  const tb = $('#risk-tbody');
  if(!data.length){tb.innerHTML=`<tr><td colspan="5" class="empty">${t('noCustomRules')}</td></tr>`;return;}
  tb.innerHTML=data.map(r=>`<tr>
    <td>${esc(r.name)}</td>
    <td style="font-family:monospace;font-size:12px">${esc(r.pattern)}</td>
    <td>${t(ACTION_TKEY[r.action]||'mute')}</td>
    <td><span class="badge badge-${r.enabled?'green':'gray'}">${r.enabled?t('ruleOn'):t('ruleOff')}</span></td>
    <td><button class="btn btn-outline btn-sm" data-toggle-id="${r.id}" data-toggle-enabled="${r.enabled?1:0}">${r.enabled?t('disableBtn'):t('enableBtn')}</button>
      <button class="btn btn-danger btn-sm" data-rule-del-id="${r.id}">${t('remove')}</button></td>
  </tr>`).join('');
}
window.openRuleModal = () => openModal(t('ruleModalTitle'),`
  <div class="form-group"><label>${t('ruleName')}</label><input type="text" id="rr-name"/></div>
  <div class="form-group"><label>${t('rulePattern')}</label><input type="text" id="rr-pat" placeholder="${t('rulePatternPlaceholder')}"/></div>
  <div class="form-group"><label>${t('ruleActionLabel')}</label>
    <select id="rr-action">${RISK_ACTIONS.filter(([v])=>v!=='off').map(([v,k])=>`<option value="${v}">${t(k)}</option>`).join('')}</select></div>`,
  [{label:t('cancel'),onClick:closeModal},{label:t('add'),cls:'btn-primary',onClick:async()=>{
    try{await api('/risk/rules',{method:'POST',body:{name:$('#rr-name').value,pattern:$('#rr-pat').value,action:$('#rr-action').value}});closeModal();toast(t('ruleAddedMsg'),'success');loadRisk();}catch(e){toast(e.message,'error');}
  }}]);
window.toggleRule = async(id,enabled)=>{
  try{await api(`/risk/rules/${id}/toggle`,{method:'POST',body:{enabled:!enabled}});loadRisk();}catch(e){toast(e.message,'error');}
};
window.deleteRule = async(id)=>{
  if(!confirm(t('confirmRemove')))return;
  try{await api(`/risk/rules/${id}`,{method:'DELETE'});toast(t('removedMsg'),'success');loadRisk();}catch(e){toast(e.message,'error');}
};

async function loadAudit() {
  const data = await api('/audit?limit=100');
  const tb = $('#audit-tbody');
  if(!data.length){tb.innerHTML=`<tr><td colspan="4" class="empty">${t('noLogs')}</td></tr>`;return;}
  tb.innerHTML=data.map(r=>`<tr>
    <td><code style="font-size:12px">${esc(r.action)}</code></td>
    <td>${esc(r.actor_id)||t('systemActor')}</td>
    <td>${r.target_type?`${esc(r.target_type)}:${esc(r.target_id)}`:'—'}</td>
    <td>${fmtTime(r.created_at)}</td>
  </tr>`).join('');
}

async function loadMonitor() {
  const data = await api('/metrics');
  const grid = $('#health-grid');
  grid.innerHTML = Object.entries(data.components||{}).map(([name,c])=>`
    <div class="health-item">
      <div class="health-name"><span class="dot dot-${c.status==='ok'?'green':c.status==='warn'?'yellow':'red'}"></span>${esc(name)}</div>
      <div class="health-detail">${esc(c.message)||esc(JSON.stringify(c.detail||{}))}</div>
    </div>`).join('') || `<div class="empty">${t('noData')}</div>`;
}

async function loadUpdate() {
  $('#update-info').textContent = t('checking');
  const data = await api('/update/check');
  window.GuardianReleaseView.renderUpdatePanel($('#update-info'), data, {
    upToDate: current => t('upToDate', {cur:current}),
    updateAvailable: (current, latest) => t('updateAvailable', {cur:current, latest}),
    viewRelease: t('viewReleaseBtn'),
    install: version => t('installBtn', {v:version}),
    noBuildAsset: t('noBuildAssetMsg'),
    manageVersions: t('manageVersionsBtn'),
  }, {
    onUpdate: release => window.doUpdate(release.version, release.downloadUrl, release.checksumUrl, release.publishedAt),
    onManage: window.openVersionModal,
  });
}
window.doUpdate = async(v,u,c,p)=>{
  if(!confirm(t('confirmInstall',{v})))return;
  try{await api('/update/download',{method:'POST',body:{version:v,downloadUrl:u,checksumUrl:c,publishedAt:p,releaseNotes:''}});toast(t('updateAppliedMsg'),'success');}catch(e){toast(e.message,'error');}
};

// ─── Version Management modal ──────────────────────────────────────────────
// Mirrors NapCat's own "版本管理" dialog: current version + repo, tabs for
// stable/pre-release, a search box, a paginated version list with
// 当前/降级 badges, and an "更新到此版本" action for the selected row.
// IMPORTANT: search input/tabs are rendered ONCE; only the list+pagination
// are re-rendered on every interaction, so the search field never loses
// keyboard focus while typing.
let _vm = { releases: [], tab: 'stable', search: '', page: 1, pageSize: 8, selected: null, current: '', githubRepo: '' };

function vmCompare(version) {
  if (version === _vm.current) return 'current';
  const p = s => s.split('.').map(Number);
  const [a1,a2,a3] = p(version), [b1,b2,b3] = p(_vm.current);
  if (a1!==b1) return a1>b1 ? 'newer' : 'older';
  if (a2!==b2) return a2>b2 ? 'newer' : 'older';
  return a3>b3 ? 'newer' : 'older';
}
function vmFmtDate(iso) { return iso ? new Date(iso).toLocaleDateString() : '—'; }

window.openVersionModal = async () => {
  $('#modal-title').textContent = t('versionModalTitle');
  $('#modal-body').innerHTML = `<div class="empty">${t('loadingBotInfo')}</div>`;
  $('#modal-footer').innerHTML = '';
  $('#modal-overlay').classList.add('open');
  try {
    const data = await api('/update/releases');
    _vm = { releases: data.releases||[], tab:'stable', search:'', page:1, pageSize:8, selected:null, current:data.current, githubRepo:data.githubRepo };
    vmRenderShell();
  } catch(e) {
    $('#modal-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
};

function vmRenderShell() {
  $('#modal-body').innerHTML = `
    <div style="margin-bottom:12px;font-size:13px;color:var(--muted)">
      ${t('currentVersionLabel')}: <strong id="vm-current"></strong> &nbsp;·&nbsp; ${t('repoLabel')}: <code id="vm-repo"></code>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:12px;border-bottom:1px solid var(--border)">
      <div class="vm-tab" data-tab="stable" style="padding:8px 2px;cursor:pointer;font-size:13px"></div>
      <div class="vm-tab" data-tab="prerelease" style="padding:8px 2px;cursor:pointer;font-size:13px"></div>
    </div>
    <input type="text" id="vm-search" placeholder="${t('searchVersionPlaceholder')}"/>
    <div style="font-size:12px;color:var(--muted);margin:8px 0" id="vm-count"></div>
    <div style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px" id="vm-list"></div>
    <div style="display:flex;justify-content:center;gap:6px;margin-top:12px;flex-wrap:wrap" id="vm-pagination"></div>`;
  $('#vm-current').textContent = `v${String(_vm.current ?? '')}`;
  $('#vm-repo').textContent = String(_vm.githubRepo || '-');
  document.querySelectorAll('.vm-tab').forEach(el => {
    el.onclick = () => { _vm.tab = el.dataset.tab; _vm.page = 1; _vm.selected = null; vmRenderTabs(); vmRenderList(); vmRenderFooter(); };
  });
  $('#vm-search').oninput = e => { _vm.search = e.target.value; _vm.page = 1; vmRenderList(); };
  vmRenderTabs();
  vmRenderList();
  vmRenderFooter();
}

function vmRenderTabs() {
  document.querySelectorAll('.vm-tab').forEach(el => {
    const active = el.dataset.tab === _vm.tab;
    el.textContent = t(el.dataset.tab === 'stable' ? 'stableTab' : 'prereleaseTab');
    el.style.borderBottom = '2px solid ' + (active ? 'var(--primary)' : 'transparent');
    el.style.color = active ? 'var(--primary)' : 'var(--muted)';
  });
}

function vmRenderList() {
  const search = _vm.search.toLowerCase();
  const filtered = _vm.releases.filter(r =>
    (_vm.tab === 'stable' ? !r.prerelease : r.prerelease) &&
    (!search || String(r.version ?? '').toLowerCase().includes(search))
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / _vm.pageSize));
  _vm.page = Math.min(_vm.page, totalPages);
  const pageItems = filtered.slice((_vm.page-1)*_vm.pageSize, _vm.page*_vm.pageSize);

  $('#vm-count').textContent = t('totalVersionsLabel', { n: filtered.length });
  window.GuardianReleaseView.renderVersionRows($('#vm-list'), pageItems, {
    labels: {
      noVersions: t('noVersionsFound'),
      current: t('currentBadge'),
      downgrade: t('downgradeBadge'),
    },
    compare: vmCompare,
    formatDate: vmFmtDate,
    isSelected: release => _vm.selected === release,
    onSelect: release => {
      _vm.selected = release;
      vmRenderList();
      vmRenderFooter();
    },
  });
  vmRenderPagination(totalPages);
}

function vmRenderPagination(totalPages) {
  const pag = $('#vm-pagination');
  if (totalPages <= 1) { pag.innerHTML = ''; return; }
  const maxBtns = 5;
  let start = Math.max(1, _vm.page - 2);
  let end = Math.min(totalPages, start + maxBtns - 1);
  start = Math.max(1, end - maxBtns + 1);
  let html = `<button class="btn btn-outline btn-sm" id="vm-prev" ${_vm.page<=1?'disabled':''}>‹</button>`;
  for (let p = start; p <= end; p++) html += `<button class="btn ${p===_vm.page?'btn-primary':'btn-outline'} btn-sm vm-page" data-page="${p}">${p}</button>`;
  html += `<button class="btn btn-outline btn-sm" id="vm-next" ${_vm.page>=totalPages?'disabled':''}>›</button>`;
  pag.innerHTML = html;
  $('#vm-prev').onclick = () => { if(_vm.page>1){_vm.page--;vmRenderList();} };
  $('#vm-next').onclick = () => { if(_vm.page<totalPages){_vm.page++;vmRenderList();} };
  document.querySelectorAll('.vm-page').forEach(el => el.onclick = () => { _vm.page = Number(el.dataset.page); vmRenderList(); });
}

function vmRenderFooter() {
  $('#modal-footer').innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-outline'; closeBtn.textContent = t('cancel'); closeBtn.onclick = closeModal;
  const updateBtn = document.createElement('button');
  updateBtn.className = 'btn btn-primary'; updateBtn.textContent = t('updateToThisVersionBtn');
  const disabled = !_vm.selected || vmCompare(_vm.selected.version) === 'current';
  if (disabled) { updateBtn.disabled = true; updateBtn.style.opacity = '0.5'; updateBtn.style.cursor = 'default'; }
  updateBtn.onclick = async () => {
    if (!_vm.selected) return;
    if (!confirm(t('confirmInstall',{v:_vm.selected.version}))) return;
    try {
      await api('/update/download', { method:'POST', body: {
        version: _vm.selected.version, downloadUrl: _vm.selected.downloadUrl, checksumUrl: _vm.selected.checksumUrl,
        publishedAt: _vm.selected.publishedAt, releaseNotes: '',
      }});
      closeModal();
      toast(t('updateAppliedMsg'), 'success');
    } catch(e) { toast(e.message, 'error'); }
  };
  $('#modal-footer').appendChild(closeBtn);
  $('#modal-footer').appendChild(updateBtn);
}

async function loadStatistics() {
  const s = await api('/stats');
  const t_ = s.totals;
  $('#stats-grid2').innerHTML=[
    {v:t_.approvals_total,l:t('totalApprovals')},{v:t_.approvals_passed,l:t('approvedStat')},
    {v:t_.approvals_rejected,l:t('rejectedStat')},{v:t_.punishments_total,l:t('punishmentsStat')},
    {v:t_.risk_detections,l:t('riskDetections')},{v:t_.captchas_passed,l:t('captchasOk')},
  ].map(x=>`<div class="stat-card"><div class="stat-val">${x.v}</div><div class="stat-label">${x.l}</div></div>`).join('');
  renderTrendChart(s.recent30Days);
}

// ─── 30-day trend chart (inline SVG, three fixed series) ─────────────────────
// Series hues are the first three categorical slots of a CVD-validated palette
// (light + dark steps validated separately against each surface). The legend,
// per-day tooltip, and the data table make identity never color-alone.
const TREND_SERIES = [
  {key:'approvals_total', tKey:'trendApprovals', color:'var(--ch1)'},
  {key:'risk_detections', tKey:'trendRisk',      color:'var(--ch2)'},
  {key:'punishments_total', tKey:'trendPunish',  color:'var(--ch3)'},
];

function renderTrendChart(rows) {
  const wrap = $('#trend-chart'), legend = $('#trend-legend');
  const days = Array.from({length:30},(_,i)=>{const d=new Date();d.setDate(d.getDate()-29+i);return d.toISOString().slice(0,10);});
  const byPeriod = {};
  for (const r of rows||[]) byPeriod[r.period] = r;
  const data = days.map(p => ({period:p, vals:TREND_SERIES.map(s => Number(byPeriod[p]?.[s.key]||0))}));

  legend.innerHTML = TREND_SERIES.map(s =>
    `<span style="display:inline-flex;align-items:center;gap:6px;color:var(--muted)"><span style="width:10px;height:10px;border-radius:3px;background:${s.color}"></span>${t(s.tKey)}</span>`).join('');
  $('#trend-tbody').innerHTML = [...data].reverse().map(d =>
    `<tr><td>${d.period}</td>${d.vals.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('');

  if (!(rows||[]).length) { wrap.innerHTML = `<div class="empty">${t('trendEmpty')}</div>`; return; }

  const W = Math.max(wrap.clientWidth || 600, 320), H = 220;
  const M = {t:12, r:96, b:26, l:36}; // right margin holds the direct end labels
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const maxVal = Math.max(1, ...data.flatMap(d => d.vals));
  const pow = Math.pow(10, Math.floor(Math.log10(maxVal)));
  const yMax = [1,2,5,10].map(m=>m*pow).find(v=>v>=maxVal);
  const x = i => M.l + i*(iw/(days.length-1));
  const y = v => M.t + ih - (v/yMax)*ih;

  const grid = [0,.5,1].map(f => {
    const gy = M.t + ih - f*ih;
    return `<line x1="${M.l}" y1="${gy}" x2="${M.l+iw}" y2="${gy}" stroke="var(--border)" stroke-width="1"/>`+
      `<text x="${M.l-6}" y="${gy+4}" text-anchor="end" font-size="10" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${Math.round(f*yMax)}</text>`;
  }).join('');
  const xticks = [0,7,14,21,29].map(i =>
    `<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${days[i].slice(5)}</text>`).join('');

  const paths = TREND_SERIES.map((s,si) =>
    `<path d="${data.map((d,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(d.vals[si]).toFixed(1)}`).join('')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');

  // Direct end labels: text stays in muted ink, a colored dot carries identity.
  const ends = TREND_SERIES.map((s,si)=>({t:t(s.tKey), color:s.color, ey:y(data[data.length-1].vals[si])}))
    .sort((a,b)=>a.ey-b.ey);
  for (let i=1;i<ends.length;i++) if (ends[i].ey - ends[i-1].ey < 14) ends[i].ey = ends[i-1].ey + 14;
  const endLabels = ends.map(e => {
    const ly = Math.min(Math.max(e.ey, M.t+4), M.t+ih-2);
    return `<circle cx="${M.l+iw+8}" cy="${ly}" r="3.5" fill="${e.color}"/>`+
      `<text x="${M.l+iw+16}" y="${ly+4}" font-size="11" fill="var(--muted)">${e.t}</text>`;
  }).join('');

  const hover = `<line id="tr-cross" y1="${M.t}" y2="${M.t+ih}" x1="0" x2="0" stroke="var(--muted)" stroke-width="1" opacity="0"/>`+
    TREND_SERIES.map((s,si)=>`<circle id="tr-dot-${si}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" opacity="0"/>`).join('');

  wrap.innerHTML = `<svg width="${W}" height="${H}" role="img" style="display:block;max-width:100%">${grid}${xticks}${paths}${endLabels}${hover}</svg>`+
    `<div id="tr-tip" style="position:absolute;top:0;display:none;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;box-shadow:var(--shadow);z-index:5;white-space:nowrap"></div>`;

  const svg = wrap.querySelector('svg');
  const showAt = i => {
    const cx = x(i);
    const cross = $('#tr-cross');
    cross.setAttribute('x1',cx); cross.setAttribute('x2',cx); cross.setAttribute('opacity','.5');
    TREND_SERIES.forEach((s,si) => {
      const dot = $(`#tr-dot-${si}`);
      dot.setAttribute('cx',cx); dot.setAttribute('cy',y(data[i].vals[si])); dot.setAttribute('opacity','1');
    });
    const tip = $('#tr-tip');
    tip.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">${data[i].period}</div>`+
      TREND_SERIES.map((s,si)=>`<div style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:${s.color}"></span>${t(s.tKey)}&nbsp;<strong style="margin-left:auto;font-variant-numeric:tabular-nums">${data[i].vals[si]}</strong></div>`).join('');
    tip.style.display = 'block';
    tip.style.left = Math.min(Math.max(cx - tip.offsetWidth/2, 0), W - tip.offsetWidth) + 'px';
  };
  svg.addEventListener('mousemove', ev => {
    const mx = ev.clientX - svg.getBoundingClientRect().left;
    showAt(Math.max(0, Math.min(days.length-1, Math.round((mx - M.l)/(iw/(days.length-1))))));
  });
  svg.addEventListener('mouseleave', () => {
    $('#tr-cross').setAttribute('opacity','0');
    TREND_SERIES.forEach((_,si)=>$(`#tr-dot-${si}`).setAttribute('opacity','0'));
    $('#tr-tip').style.display = 'none';
  });
}

// Detector → action mapping. Each detector names its consequence directly;
// when several detectors match one message, the most severe action wins.
const RISK_DETECTORS = ['advertising','fraud','grayMarket','pornography','political','gambling','shortLinks','duplicateMessages','spam','cardMessage','aiViolation'];
const RISK_ACTIONS = [['mute','mute'],['kick','kick'],['notify_admin','notifyAdmin'],['log_only','logOnly'],['off','offAction']];
const ACTION_TKEY = {mute:'mute',kick:'kick',notify_admin:'notifyAdmin',log_only:'logOnly',off:'offAction'};

function renderDetectorActions(current) {
  $('#detector-actions').innerHTML = RISK_DETECTORS.map(d => `
    <label style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:400">
      <span>${t('det_'+d)}</span>
      <select data-detector="${d}" style="width:auto;min-width:110px">
        ${RISK_ACTIONS.map(([v,k])=>`<option value="${v}" ${(current?.[d]||'off')===v?'selected':''}>${t(k)}</option>`).join('')}
      </select>
    </label>`).join('');
}

async function loadSettings() {
  const cfg = await api('/config');
  $('#cfg-selfid').value = cfg.core?.selfId||'';
  renderDetectorActions(cfg.risk?.detectorActions||{});
  $('#cfg-mute-duration').value = cfg.risk?.muteDurationSeconds??600;
  $('#cfg-ai-min').value = cfg.risk?.aiMinScore??70;
  $('#cfg-recall').checked = cfg.risk?.recallMessage === true;
  $('#cfg-builtin-reject').checked = cfg.approval?.useBuiltinRejectKeywords !== false;
  $('#cfg-builtin-approve').checked = cfg.approval?.useBuiltinApproveKeywords === true;
  _builtinApproveWasEnabled = cfg.approval?.useBuiltinApproveKeywords === true;
  $('#cfg-intel-enabled').checked = cfg.intel?.enabled === true;
  $('#cfg-commands-enabled').checked = cfg.commands?.enabled !== false;
  $('#cfg-command-prefix').value = cfg.commands?.prefix||'/guard';
  $('#cfg-timezone').value = cfg.core?.timezone||'Asia/Shanghai';
  $('#cfg-githubrepo').value = cfg.update?.githubRepo||'';
}
let _builtinApproveWasEnabled = false;
async function saveConfig() {
  try{
    const builtinApproveEnabled = $('#cfg-builtin-approve').checked === true;
    if (builtinApproveEnabled && !_builtinApproveWasEnabled && !confirm(t('confirmBuiltinApprove'))) return;
    await api('/config',{method:'POST',body:{
      core:{selfId:$('#cfg-selfid').value.trim()||'0',
        timezone:$('#cfg-timezone').value.trim()||'Asia/Shanghai'},
      risk:{
        detectorActions:Object.fromEntries([...document.querySelectorAll('#detector-actions select')].map(s=>[s.dataset.detector,s.value])),
        muteDurationSeconds:Number($('#cfg-mute-duration').value)||600,
        aiMinScore:Math.min(100,Math.max(0,Number($('#cfg-ai-min').value)||70)),
        recallMessage:$('#cfg-recall').checked === true,
      },
      commands:{
        enabled:$('#cfg-commands-enabled').checked === true,
        prefix:$('#cfg-command-prefix').value.trim()||'/guard',
      },
      approval:{
        useBuiltinRejectKeywords:$('#cfg-builtin-reject').checked === true,
        useBuiltinApproveKeywords:builtinApproveEnabled,
      },
      intel:{enabled:$('#cfg-intel-enabled').checked === true},
      update:{githubRepo:$('#cfg-githubrepo').value.trim()},
    }});
    _builtinApproveWasEnabled = builtinApproveEnabled;
    toast(t('settingsSavedMsg'),'success');
  }catch(e){toast(e.message,'error');}
}

// ─── Init ─────────────────────────────────────────────────────────────────────
applyI18n();
buildNav();
// NOTE: navigateTo() is intentionally NOT called here.
// It fires api() calls that require authentication. It is called instead
// inside initAuth() / doLogin() once a valid token has been established.



// Delegated listeners for dynamically-generated table buttons
document.getElementById('groups-tbody').addEventListener('click', e => {
  const btn = e.target.closest('[data-keyword-gid]');
  if (btn) openKeywordModal(btn.dataset.keywordGid);
});
document.getElementById('approval-tbody').addEventListener('click', e => {
  const a = e.target.closest('[data-approve-id]');
  if (a) { approveReq(Number(a.dataset.approveId)); return; }
  const r = e.target.closest('[data-reject-id]');
  if (r) rejectReq(Number(r.dataset.rejectId));
});
document.getElementById('punishments-tbody').addEventListener('click', e => {
  const btn = e.target.closest('[data-revoke-id]');
  if (btn) revokePunishment(Number(btn.dataset.revokeId));
});
document.getElementById('blacklist-tbody').addEventListener('click', e => {
  const btn = e.target.closest('[data-bl-uid]');
  if (btn) removeBlacklist(btn.dataset.blUid, btn.dataset.blGid || null);
});
document.getElementById('risk-tbody').addEventListener('click', e => {
  const del = e.target.closest('[data-rule-del-id]');
  if (del) { deleteRule(Number(del.dataset.ruleDelId)); return; }
  const btn = e.target.closest('[data-toggle-id]');
  if (btn) toggleRule(Number(btn.dataset.toggleId), btn.dataset.toggleEnabled === '1');
});

// ─── Users management page ────────────────────────────────────────────────────
function roleLabel(r) {
  return t({'super_admin':'userRoleSuperAdmin','group_admin':'userRoleGroupAdmin',
             'auditor':'userRoleAuditor','viewer':'userRoleViewer','member':'userRoleMember'}[r]||r);
}

async function loadUsers() {
  const [users, currentUser] = await Promise.all([api('/users'), api('/auth/me')]);
  const usableSuperAdminCount = users.filter(u => u.is_usable_super_admin === true).length;
  const tb = $('#users-tbody');
  if (!users.length) { tb.innerHTML = `<tr><td colspan="5" class="empty">${t('noData')}</td></tr>`; return; }
  tb.innerHTML = users.map(u => {
    const locked = u.locked_until && Date.now() < u.locked_until;
    const status = locked ? `<span class="badge badge-red">${t('userStatusLocked')}</span>`
                          : `<span class="badge badge-green">${t('userStatusNormal')}</span>`;
    const unlockBtn = locked
      ? `<button class="btn btn-outline btn-sm" data-user-unlock="${esc(u.id)}">${t('userUnlockBtn')}</button> ` : '';
    const deleteState = globalThis.QQGuardianUserSecurity.deleteState(
      u,
      currentUser.id,
      usableSuperAdminCount,
    );
    const deleteReason = deleteState.reason === 'self'
      ? t('userDeleteSelfDisabled')
      : deleteState.reason === 'last_usable_super_admin'
        ? t('userDeleteLastAdminDisabled')
        : '';
    const deleteDisabled = deleteState.disabled ? ' disabled aria-disabled="true"' : '';
    const deleteTitle = deleteReason ? ` title="${esc(deleteReason)}"` : '';
    const deleteHint = deleteReason ? `<span class="action-hint">${esc(deleteReason)}</span>` : '';
    return `<tr>
      <td>${esc(u.id)}</td>
      <td>${esc(u.username||'-')}</td>
      <td>${esc(roleLabel(u.role))}</td>
      <td>${status}</td>
      <td>
        ${unlockBtn}<button class="btn btn-outline btn-sm" data-user-password="${esc(u.id)}" data-user-name="${esc(u.username||'')}">
          ${t('userPasswordBtn')}</button>
        <button class="btn btn-danger btn-sm" data-user-delete="${esc(u.id)}" data-user-name="${esc(u.username||'')}"${deleteDisabled}${deleteTitle}>
          ${t('userDeleteBtn')}</button>${deleteHint}
      </td></tr>`;
  }).join('');
}

function openCreateUserModal() {
  openModal(t('createUserTitle'), `
    <div class="form-group"><label>${t('thUsername')}</label><input id="nu-username" placeholder="${t('usernamePlaceholder')}"/></div>
    <div class="form-group"><label>${t('thRole')}</label>
      <select id="nu-role">
        <option value="super_admin">${t('userRoleSuperAdmin')}</option>
        <option value="group_admin">${t('userRoleGroupAdmin')}</option>
        <option value="auditor">${t('userRoleAuditor')}</option>
        <option value="viewer" selected>${t('userRoleViewer')}</option>
        <option value="member">${t('userRoleMember')}</option>
      </select></div>
    <div class="form-group"><label>${t('thPassword')}</label><input type="password" id="nu-password" placeholder="${t('passwordPlaceholder')}"/></div>
  `, [
    {label:t('confirm'),cls:'btn-primary',onClick:async()=>{
      const username=$('#nu-username').value.trim(), role=$('#nu-role').value, password=$('#nu-password').value;
      if(!username||!password){toast('Username and password required','error');return;}
      await api('/users',{method:'POST',body:{username,role,password}});
      closeModal(); toast(t('userCreated'),'success'); await loadUsers();
    }},
    {label:t('cancel'),onClick:closeModal},
  ]);
}

function openPasswordModal(id, name) {
  openModal(`${t('editPasswordTitle')} — ${esc(name)}`, `
    <div class="form-group"><label>${t('thPassword')}</label>
      <input type="password" id="pw-new" placeholder="${t('passwordPlaceholder')}"/></div>
  `, [
    {label:t('confirm'),cls:'btn-primary',onClick:async()=>{
      const password=$('#pw-new').value;
      if(!password){toast('Password required','error');return;}
      await api(`/users/${id}/password`,{method:'POST',body:{password}});
      closeModal(); toast(t('userUpdated'),'success');
    }},
    {label:t('cancel'),onClick:closeModal},
  ]);
}

// Static button event listeners (replaces inline onclick= attributes)
document.getElementById('btn-create-user').addEventListener('click', openCreateUserModal);
document.getElementById('users-tbody').addEventListener('click', async e => {
  const unlock = e.target.closest('[data-user-unlock]');
  if (unlock) {
    await api(`/users/${unlock.dataset.userUnlock}/unlock`, {method:'POST'});
    toast(t('userUpdated'), 'success'); await loadUsers(); return;
  }
  const pwd = e.target.closest('[data-user-password]');
  if (pwd) { openPasswordModal(pwd.dataset.userPassword, pwd.dataset.userName); return; }
  const del = e.target.closest('[data-user-delete]');
  if (del) {
    if (del.disabled) return;
    openModal(t('confirmDeleteUser'), `<p>${esc(del.dataset.userName)}</p>`, [
      {label:t('confirm'),cls:'btn-danger',onClick:async()=>{
        try {
          await api(`/users/${del.dataset.userDelete}`,{method:'DELETE'});
          closeModal(); toast(t('userDeleted'),'success'); await loadUsers();
        } catch (error) {
          toast(error.message || String(error), 'error');
          await loadUsers().catch(() => {});
        }
      }},
      {label:t('cancel'),onClick:closeModal},
    ]);
  }
});

document.getElementById('btn-refresh-groups').addEventListener('click', refreshGroups);
document.getElementById('btn-save-all-groups').addEventListener('click', saveAllGroups);
document.getElementById('btn-load-approvals').addEventListener('click', loadApprovals);
document.getElementById('btn-open-punish-modal').addEventListener('click', openPunishModal);
document.getElementById('btn-open-blacklist-modal').addEventListener('click', openBlacklistModal);
document.getElementById('btn-open-rule-modal').addEventListener('click', openRuleModal);
document.getElementById('btn-load-audit').addEventListener('click', loadAudit);
document.getElementById('btn-save-config').addEventListener('click', saveConfig);
document.getElementById('login-btn').addEventListener('click', doLogin);

// Attempt to restore session from refresh token (shows login overlay if not possible)
initAuth();

// ─── Post-auth setup (called by initAuth and doLogin after a token is confirmed) ─
function onAuthReady() {
  // Version badge — auth-gated route, must not fire before initAuth()
  api('/update/check')
    .then(d => { if (d?.current) $('#version-badge').textContent = 'v' + d.current; })
    .catch(() => {});
}
$('#version-badge').onclick = openVersionModal;

// Logout button in sidebar footer
$('#sb-logout-btn').onclick = async () => {
  const refreshToken = sessionStorage.getItem(SK_REFRESH);
  try { await api('/auth/logout', { method: 'POST', body: refreshToken ? { refreshToken } : {} }); } catch { /* ignore */ }
  _accessToken = null; _currentRole = 'viewer';
  sessionStorage.removeItem(SK_REFRESH);
  buildNav(); showLoginOverlay();
};

// Auto-refresh every 8s for a near-real-time feel — except pages that hold
// unsaved, pending local state (settings' fields, groups' toggle checkboxes
// before "Save Settings" is clicked) where a background refresh would
// silently overwrite whatever the admin is in the middle of editing. Also
// skipped while any modal is open, for the same reason.
const NO_AUTOREFRESH_PAGES = new Set(['settings', 'groups', 'users']);
setInterval(() => {
  if (NO_AUTOREFRESH_PAGES.has(_currentPage)) return;
  if ($('#modal-overlay').classList.contains('open')) return;
  if ($('#login-overlay').classList.contains('open')) return;
  loadPage(_currentPage);
}, 8000);
