/* Tampa Bay Mahj — elegant inline-SVG icon set (shared by card + profile editor). */
window.TBM_ICON_KEYS = ['tile','cup','flower','heart','sparkle','star','instagram','mail','phone','globe','bag','gift','pin','calendar','users','award','book','message'];
window.TBM_ICON_LABELS = {tile:'Tile',cup:'Teacup',flower:'Flower',heart:'Heart',sparkle:'Sparkle',star:'Star',instagram:'Instagram',mail:'Email',phone:'Phone',globe:'Website',bag:'Shop',gift:'Gift',pin:'Location',calendar:'Calendar',users:'Group',award:'Award',book:'Guide',message:'Message'};
window.TBM_ICONS = {
  tile:'<rect x="6.5" y="3" width="11" height="18" rx="2.5"/><circle cx="12" cy="8.5" r="1.5"/><path d="M9.5 13h5M9.5 16h5"/>',
  cup:'<path d="M5 8h11v4a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V8Z"/><path d="M16 9.5h1.5a2 2 0 0 1 0 4H16"/><path d="M8 3v2M11 3v2"/>',
  flower:'<circle cx="12" cy="12" r="2"/><path d="M12 10c-1-2-1-4 0-6 1 2 1 4 0 6Z"/><path d="M12 14c1 2 1 4 0 6-1-2-1-4 0-6Z"/><path d="M10 12c-2-1-4-1-6 0 2 1 4 1 6 0Z"/><path d="M14 12c2-1 4-1 6 0-2 1-4 1-6 0Z"/>',
  heart:'<path d="M12 20s-7-4.5-9-9a4.5 4.5 0 0 1 9-2 4.5 4.5 0 0 1 9 2c-2 4.5-9 9-9 9Z"/>',
  sparkle:'<path d="M12 3c.5 3 1.5 4 4.5 4.5C13.5 8 12.5 9 12 12c-.5-3-1.5-4-4.5-4.5C10.5 7 11.5 6 12 3Z"/><path d="M18 13.5c.3 1.4.8 1.9 2.2 2.2-1.4.3-1.9.8-2.2 2.2-.3-1.4-.8-1.9-2.2-2.2 1.4-.3 1.9-.8 2.2-2.2Z"/>',
  star:'<path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3Z"/>',
  instagram:'<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  phone:'<path d="M4 4h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 2 6a2 2 0 0 1 2-2Z"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/>',
  bag:'<path d="M6 8h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  gift:'<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5S10 4 7.6 5.4 9 8.5 12 8.5ZM12 8.5s2-4.5 4.4-3.1S15 8.5 12 8.5Z"/>',
  pin:'<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3 3 0 0 1 0 4.8M20.5 20a5.5 5.5 0 0 0-3.5-5.1"/>',
  award:'<circle cx="12" cy="9" r="5"/><path d="M9 13.5 7.5 21 12 18l4.5 3L15 13.5"/>',
  book:'<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18v15H6.5A1.5 1.5 0 0 0 5 19.5V4.5Z"/><path d="M18 18v3H6.5A1.5 1.5 0 0 1 5 19.5"/>',
  message:'<path d="M4 5h16v10H9l-4 3.5V5Z"/>'
};
window.tbmIcon = function(key){
  var inner = window.TBM_ICONS[key];
  if(!inner) return '';
  return '<svg class="tbmic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">'+inner+'</svg>';
};
