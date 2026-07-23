(function(){
  function ready(fn){ if(document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded',fn); }
  ready(function(){
    if(!document.getElementById('appnav-css')){
      var css=document.createElement('style'); css.id='appnav-css';
      css.textContent=
        ".tbmnav .navtoggle{display:none;background:none;border:none;color:inherit;font-size:1.6rem;line-height:1;cursor:pointer;padding:2px 8px}"+
        "@media(max-width:720px){"+
          ".tbmnav .navtoggle{display:inline-flex;margin-left:auto}"+
          ".tbmnav>a{display:none;width:100%;padding:12px 2px;border-top:1px solid rgba(255,255,255,.16);font-size:1rem}"+
          ".tbmnav.open>a{display:block}"+
          ".tbmnav .brand{margin-right:0}"+
        "}";
      document.head.appendChild(css);
    }
    var nav=document.querySelector('.tbmnav');
    if(nav && !nav.querySelector('.navtoggle')){
      var btn=document.createElement('button'); btn.className='navtoggle'; btn.setAttribute('aria-label','Menu'); btn.setAttribute('aria-expanded','false'); btn.innerHTML='☰';
      btn.addEventListener('click',function(){ var o=nav.classList.toggle('open'); btn.setAttribute('aria-expanded',o?'true':'false'); });
      var brand=nav.querySelector('.brand');
      if(brand && brand.nextSibling) nav.insertBefore(btn, brand.nextSibling); else nav.appendChild(btn);
    }
    var lo=document.getElementById('tbmLogout');
    if(lo && !lo._w){ lo._w=1; lo.addEventListener('click',function(){ fetch('/api/auth/logout',{method:'POST'}).then(function(){location.href='/login';}); }); }
  });
})();
