// Open the terminal, optionally preselecting a property.
function openTerminal(site) {
  const url = chrome.runtime.getURL('chart.html') + (site ? '?site=' + encodeURIComponent(site) : '');
  chrome.tabs.create({ url });
}
function siteFromUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname === 'search.google.com') return url.searchParams.get('resource_id');
  } catch (e) {}
  return null;
}
chrome.action.onClicked.addListener(tab => openTerminal(siteFromUrl(tab.url || '')));
