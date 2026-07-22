/* Tampa Bay Mahj — shared collapsible left sidebar (admin pages). */
(function(){
  var I={
    dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    schedule:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
    students:'<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3 3 0 0 1 0 4.8M20.5 20a5.5 5.5 0 0 0-3.5-5.1"/>',
    profile:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10.5" r="2"/><path d="M5.5 17a3.5 3.5 0 0 1 7 0"/><path d="M15 9.5h4M15 13h4"/>',
    inquiry:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    card:'<path d="M12 3c.5 3 1.5 4 4.5 4.5C13.5 8 12.5 9 12 12c-.5-3-1.5-4-4.5-4.5C10.5 7 11.5 6 12 3Z"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 12a7.5 7.5 0 0 0-.1-1.2l1.9-1.5-1.8-3.1-2.3.9a7 7 0 0 0-2-1.2L14.6 2.5h-3.6l-.4 2.4a7 7 0 0 0-2 1.2l-2.3-.9L2.5 8.3l1.9 1.5A7.5 7.5 0 0 0 4.3 12c0 .4 0 .8.1 1.2l-1.9 1.5 1.8 3.1 2.3-.9a7 7 0 0 0 2 1.2l.4 2.4h3.6l.4-2.4a7 7 0 0 0 2-1.2l2.3.9 1.8-3.1-1.9-1.5c.1-.4.1-.8.1-1.2Z"/>',
    logout:'<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M14 12h7M18 8l3 4-3 4"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>'
  };
  function svg(k){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+I[k]+'</svg>';}
  var css=document.createElement('style');
  css.textContent=`
  :root{--sbw:226px;--sbc:74px}
  body{padding-left:var(--sbw);transition:padding-left .18s ease}
  .tbmnav,.nav{display:none!important}
  .tbmsb{position:fixed;top:0;left:0;height:100vh;width:var(--sbw);background:var(--sage-dk,#3B4832);color:var(--cream,#F7F2E4);display:flex;flex-direction:column;z-index:1000;transition:width .18s ease,transform .2s ease;box-shadow:2px 0 20px rgba(44,51,39,.18);font-family:'Karla',system-ui,sans-serif}
  .sb-top{display:flex;align-items:center;gap:10px;padding:16px 14px 10px}
  .sb-mono{width:38px;height:38px;border-radius:50%;flex:none;overflow:hidden;background:radial-gradient(circle,#fff,#EFE7CC);border:2px solid var(--gold,#C9A24B);display:flex;align-items:center;justify-content:center;cursor:pointer}
  .sb-mono img{width:100%;height:100%;object-fit:cover;display:block}
  .sb-name{font-family:'Cormorant Garamond',Georgia,serif;font-weight:700;font-size:1.12rem;line-height:1.05;white-space:nowrap;overflow:hidden}
  .sb-toggle{margin-left:auto;background:none;border:none;color:var(--gold-soft,#E3CD96);font-size:1.2rem;cursor:pointer;opacity:.75;padding:4px}
  .sb-toggle:hover{opacity:1}
  .sb-nav{display:flex;flex-direction:column;gap:3px;padding:10px 10px 0}
  .sb-bottom{margin-top:auto;display:flex;flex-direction:column;gap:3px;padding:10px;border-top:1px solid rgba(227,205,150,.18)}
  .tbmsb a{display:flex;align-items:center;gap:13px;padding:11px 12px;border-radius:11px;color:var(--cream,#F7F2E4);text-decoration:none;font-size:.9rem;font-weight:500;opacity:.82;white-space:nowrap;cursor:pointer}
  .tbmsb a:hover{background:rgba(247,242,228,.08);opacity:1}
  .tbmsb a.active{background:rgba(201,162,75,.18);opacity:1;font-weight:700;box-shadow:inset 3px 0 0 var(--gold,#C9A24B)}
  .tbmsb a svg{flex:none;width:20px;height:20px}
  .sb-ico{flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center}
  .sb-ico svg{width:20px;height:20px}
  .sb-ava{width:26px;height:26px;border-radius:50%;object-fit:cover;border:1.5px solid var(--gold,#C9A24B);display:block;background:#fff}
  .sb-hamburger{display:none;position:fixed;top:12px;left:12px;z-index:1100;width:44px;height:44px;border-radius:12px;background:var(--sage-dk,#3B4832);color:var(--cream,#F7F2E4);border:none;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(44,51,39,.25)}
  .sb-hamburger svg{width:22px;height:22px}
  .sb-backdrop{display:none;position:fixed;inset:0;background:rgba(44,51,39,.45);z-index:999}
  @media(min-width:721px){
    body.sb-collapsed{padding-left:var(--sbc)}
    body.sb-collapsed .tbmsb{width:var(--sbc)}
    body.sb-collapsed .sb-name,body.sb-collapsed .sb-toggle,body.sb-collapsed .lbl{display:none}
    body.sb-collapsed .sb-top{justify-content:center;padding:16px 0 10px}
    body.sb-collapsed .tbmsb a{justify-content:center;padding:11px 0}
  }
  @media(max-width:720px){
    body{padding-left:0}
    .tbmsb{transform:translateX(-100%)}
    body.sb-open .tbmsb{transform:none;box-shadow:4px 0 34px rgba(0,0,0,.32)}
    .sb-toggle{display:none}
    .sb-hamburger{display:flex}
    body.sb-open .sb-backdrop{display:block}
  }`;
  document.head.appendChild(css);

  var path=location.pathname.replace(/\/$/,'')||'/';
  function item(href,key,label,ext){var a=(path===href)?' class="active"':'';var t=ext?' target="_blank"':'';return '<a href="'+href+'"'+a+t+'><span class="sb-ico">'+svg(key)+'</span><span class="lbl">'+label+'</span></a>';}
  var sb=document.createElement('aside');
  sb.className='tbmsb';
  sb.innerHTML=
    '<div class="sb-top"><span class="sb-mono" id="sbMono"><img src="/logo.png" alt="H" id="sbMonoImg"></span><span class="sb-name">Tampa Bay Mahj</span><button class="sb-toggle" id="sbToggle" title="Collapse">&#171;</button></div>'+
    '<nav class="sb-nav">'+
      item('/dashboard','dashboard','Dashboard')+
      item('/students','students','Students')+
      item('/schedule','schedule','Events')+
      item('/inquiries','inquiry','Inquiry')+
      item('/profile','profile','Profile')+
    '</nav>'+
    '<div class="sb-bottom">'+
      '<a href="/settings"'+(path==='/settings'?' class="active"':'')+'><span class="sb-ico">'+svg('settings')+'</span><span class="lbl">Settings</span></a>'+
      '<a id="sbLogout"><span class="sb-ico">'+svg('logout')+'</span><span class="lbl">Log out</span></a>'+
    '</div>';
  document.body.insertBefore(sb,document.body.firstChild);

  var ham=document.createElement('button');ham.className='sb-hamburger';ham.innerHTML=svg('menu');document.body.appendChild(ham);
  var bd=document.createElement('div');bd.className='sb-backdrop';document.body.appendChild(bd);

  function setCollapsed(c){document.body.classList.toggle('sb-collapsed',c);try{localStorage.setItem('tbm_sb',c?'1':'0');}catch(e){}}
  var saved;try{saved=localStorage.getItem('tbm_sb');}catch(e){}
  setCollapsed(saved==='1');
  document.getElementById('sbToggle').addEventListener('click',function(){setCollapsed(!document.body.classList.contains('sb-collapsed'));});
  document.getElementById('sbMono').addEventListener('click',function(){if(document.body.classList.contains('sb-collapsed'))setCollapsed(false);});
  document.getElementById('sbLogout').addEventListener('click',function(){fetch('/api/auth/logout',{method:'POST'}).then(function(){location.href='/login';});});
  ham.addEventListener('click',function(){document.body.classList.add('sb-open');});
  bd.addEventListener('click',function(){document.body.classList.remove('sb-open');});
  Array.prototype.forEach.call(sb.querySelectorAll('a'),function(a){a.addEventListener('click',function(){document.body.classList.remove('sb-open');});});
  fetch('/api/profile').then(function(r){return r.json();}).then(function(d){
    var url=d&&d.profile&&d.profile.photo_url; if(url){var im=document.getElementById('sbMonoImg'); if(im) im.src=url;}
  }).catch(function(){});
})();
