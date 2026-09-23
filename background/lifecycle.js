// ContentPulse background: service-worker lifecycle and alarms.
function ensureScheduledBadgeAlarm() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(BADGE_ALARM_NAME, { periodInMinutes: SCHEDULED_BADGE_REFRESH_MINUTES });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BADGE_ALARM_NAME) {
      refreshScheduledAutomation();
      return;
    }
    if (alarm.name.startsWith(AUTO_FILL_ALARM_PREFIX)) {
      runScheduledAutoFillAlarm(alarm.name);
    }
  });
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    ensureScheduledBadgeAlarm();
    refreshScheduledAutomation();
  });
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    ensureScheduledBadgeAlarm();
    refreshScheduledAutomation();
  });
}

ensureScheduledBadgeAlarm();
refreshScheduledAutomation();
