const youtubePatterns = ['*://youtube.com/*','*://www.youtube.com/*','*://m.youtube.com/*','*://youtu.be/*','*://www.youtu.be/*'];
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({id:'send-link',title:'Send link to Offgrid',contexts:['link'],targetUrlPatterns:youtubePatterns});
  chrome.contextMenus.create({id:'send-page',title:'Send page to Offgrid',contexts:['page'],documentUrlPatterns:youtubePatterns});
});
function handoff(url) {
  // The handoff page validates the URL and offers a user-initiated external-app link.
  chrome.tabs.create({url:chrome.runtime.getURL('handoff.html') + '?url=' + encodeURIComponent(url || '')});
}
chrome.action.onClicked.addListener(tab => handoff(tab.url));
chrome.contextMenus.onClicked.addListener((info,tab) => {
  if(info.menuItemId === 'send-link') handoff(info.linkUrl);
  if(info.menuItemId === 'send-page') handoff(info.pageUrl || tab?.url);
});
