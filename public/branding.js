/* branding.js — paints each studio's own logo and name onto its pages.
   On public /s/<slug> pages it resolves the studio from the URL; on the
   owner's admin pages it resolves from the session. Falls back to the
   Charleston badge when a studio hasn't uploaded a logo. */
(function(){
  var m = location.pathname.match(/^\/s\/([^\/]+)/);
  var slug = m ? decodeURIComponent(m[1]) : (new URLSearchParams(location.search).get('studio') || '');
  fetch('/api/branding' + (slug ? ('?studio=' + encodeURIComponent(slug)) : '')).then(function(r){ return r.json(); }).then(function(b){
    if(!b) return;
    if(b.logo){
      document.querySelectorAll('img').forEach(function(im){
        var src = im.getAttribute('src') || '';
        if(src.indexOf('/logo.png') > -1 || src.indexOf('/charleston-badge.svg') > -1 || im.id === 'sbMonoImg' || im.classList.contains('logo')){
          im.src = b.logo;
        }
      });
    }
    if(b.name){
      document.querySelectorAll('.sb-name,[data-brandname],[data-studio-name]').forEach(function(el){ el.textContent = b.name; });
      if(document.title.indexOf('Tampa Bay Mahj') > -1){ document.title = document.title.replace('Tampa Bay Mahj', b.name); }
    }
  }).catch(function(){});
})();
