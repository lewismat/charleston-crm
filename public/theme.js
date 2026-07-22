/* Tampa Bay Mahj — heritage palettes.
   Deep forest green, antique brass, parchment. The cream and the pale
   yellow stripe are Holly's logo, so they stay put in every theme. */
window.TBM_THEMES = {
  classic: { name:'Savannah Heritage', dot:'#183A2A', vars:{
    '--cream':'#FBF7E6','--cream-2':'#F6EEBA','--cream-stripe':'#F6EEBA',
    '--sage':'#183A2A','--sage-soft':'#3E5A48','--sage-dk':'#0F2A1D',
    '--green':'#183A2A','--green-dark':'#0F2A1D','--green-soft':'#3E5A48',
    '--gold':'#B08D57','--gold-soft':'#E0CDA9','--gold-dk':'#8A6A3B',
    '--ink':'#1E2A22','--ink-soft':'#55645A','--red':'#7B3B34',
    '--tile':'#FDFBF4','--tile-edge':'#E3DAC4','--white':'#FDFBF4'} },

  navy: { name:'Charleston Navy', dot:'#13273F', vars:{
    '--cream':'#FBF7E6','--cream-2':'#F6EEBA','--cream-stripe':'#F6EEBA',
    '--sage':'#13273F','--sage-soft':'#3A5573','--sage-dk':'#0C1B2C',
    '--green':'#13273F','--green-dark':'#0C1B2C','--green-soft':'#3A5573',
    '--gold':'#B08D57','--gold-soft':'#E0CDA9','--gold-dk':'#8A6A3B',
    '--ink':'#1B2430','--ink-soft':'#53606E','--red':'#7B3B34',
    '--tile':'#FDFBF4','--tile-edge':'#E3DAC4','--white':'#FDFBF4'} },

  mahogany: { name:'Mahogany & Brass', dot:'#5A3227', vars:{
    '--cream':'#FBF7E6','--cream-2':'#F6EEBA','--cream-stripe':'#F6EEBA',
    '--sage':'#5A3227','--sage-soft':'#7C5245','--sage-dk':'#40231B',
    '--green':'#5A3227','--green-dark':'#40231B','--green-soft':'#7C5245',
    '--gold':'#B08D57','--gold-soft':'#E5D2AC','--gold-dk':'#8A6A3B',
    '--ink':'#2A211C','--ink-soft':'#6A5A51','--red':'#7B3B34',
    '--tile':'#FDFBF4','--tile-edge':'#E6DAC6','--white':'#FDFBF4'} },

  moss: { name:'Live Oak & Moss', dot:'#3E4F3A', vars:{
    '--cream':'#FBF7E6','--cream-2':'#F6EEBA','--cream-stripe':'#F6EEBA',
    '--sage':'#3E4F3A','--sage-soft':'#63745C','--sage-dk':'#2B3A28',
    '--green':'#3E4F3A','--green-dark':'#2B3A28','--green-soft':'#63745C',
    '--gold':'#B08D57','--gold-soft':'#E0CDA9','--gold-dk':'#8A6A3B',
    '--ink':'#242C21','--ink-soft':'#5A6455','--red':'#7B3B34',
    '--tile':'#FDFBF4','--tile-edge':'#E3DAC4','--white':'#FDFBF4'} }
};
function tbmApplyTheme(id){var t=window.TBM_THEMES[id]||window.TBM_THEMES.classic;var r=document.documentElement;for(var v in t.vars)r.style.setProperty(v,t.vars[v]);}
window.tbmSetTheme=function(id){try{localStorage.setItem('tbm_theme',id);}catch(e){}tbmApplyTheme(id);};
window.tbmCurrentTheme=function(){try{return localStorage.getItem('tbm_theme')||'classic';}catch(e){return 'classic';}};
tbmApplyTheme(window.tbmCurrentTheme());

/* Accessibility pass — Holly's students skew older, so this is core audience.
   Darkens muted text one step and gives every control a visible focus ring. */
(function(){
  var css = document.createElement('style');
  css.textContent =
    
    'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,' +
    'textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{' +
      'outline:2px solid #B08D57;outline-offset:2px;border-radius:6px}' +
    '@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;' +
      'transition-duration:.01ms!important}}';
  document.head.appendChild(css);
})();
