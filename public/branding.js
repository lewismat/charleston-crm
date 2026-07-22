/* branding.js — paints the studio's own logo and name across every page.
   Loaded after sidebar.js so the business logo wins over the profile photo. */
(function(){
  fetch('/api/branding').then(function(r){return r.json();}).then(function(b){
    if(!b) return;
    if(b.logo){
      // swap every stock logo image, including the sidebar monogram and loader
      document.querySelectorAll('img').forEach(function(im){
        var src=im.getAttribute('src')||'';
        if(src.indexOf('/logo.png')>-1 || im.id==='sbMonoImg'){ im.src=b.logo; }
      });
    }
    if(b.name){
      // the sidebar wordmark, the top-nav brand, and anything tagged for it
      document.querySelectorAll('.sb-name,.tbmnav .brand,[data-brandname]').forEach(function(el){
        el.textContent=b.name;
      });
      // studio name inside document titles that lead with "Tampa Bay Mahj"
      if(document.title.indexOf('Tampa Bay Mahj')>-1){
        document.title=document.title.replace('Tampa Bay Mahj', b.name);
      }
    }
  }).catch(function(){});
})();
