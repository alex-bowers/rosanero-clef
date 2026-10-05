// Synthetic pages that copy the structure of forzapalermo.it (checked 3 October 2026)
// but use original wording, so no article text from the site is stored here.

export const ARTICLE_HTML = `<!doctype html>
<html><head>
<title>Il Palermo vince in casa - ForzaPalermo</title>
<meta property="og:title" content="Il Palermo vince in casa: &egrave; una serata speciale"/>
<meta property="article:published_time" content="2026-09-29 16:57:02"/>
</head><body>
<h1 class="title">Il Palermo vince in casa: &egrave; una serata speciale</h1>
<div class="post-content">
<div class="post-text">
  <p><strong>Il Palermo ha vinto al Barbera.</strong> La partita &egrave; stata decisa nel secondo tempo da un colpo di testa su calcio d&rsquo;angolo.</p>
  <h2>I TIFOSI</h2>
  <p>I tifosi hanno riempito lo stadio fin dal primo minuto e hanno cantato per tutta la serata.</p>
  <p>&nbsp;</p>
  <p>Foto: archivio</p>
</div>
<div class="post-tags"><p>Tag: Palermo</p></div>
</div>
<div class="comment-section"><p>Un commento che non deve comparire.</p></div>
</body></html>`;

export const LISTING_HTML = `<div class="col-sm-3 menu-post-item">
<h3 class="title">
<a href="https://forzapalermo.it/prima-notizia">Prima notizia</a>
</h3>
<p class="post-meta"><a href="https://forzapalermo.it/profile/redazione">Redazione</a></p>
</div>
<div class="col-sm-3 menu-post-item">
<h3 class="title">
<a href="https://forzapalermo.it/seconda-notizia">Seconda notizia</a>
</h3>
</div>
<h3 class="title"><a href="https://forzapalermo.it/sosta-nazionali-forzapalermoit-live">Promo LIVE</a></h3>
<h3 class="title"><a href="https://forzapalermo.it/prima-notizia">Prima notizia (di nuovo)</a></h3>
<h3 class="title"><a href="https://altro-sito.example/esterna">Esterna</a></h3>
<h3 class="title"><a href="https://forzapalermo.it/profile/redazione">Profilo</a></h3>`;

// Synthetic: the real feeds returned HTTP 500 when checked, so no real item was seen.
export const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Feed</title><link>https://forzapalermo.it/rss/latest-posts</link>
<item><title>Uno</title><link>https://forzapalermo.it/prima-notizia</link></item>
<item><title>Due</title><link><![CDATA[https://forzapalermo.it/seconda-notizia]]></link></item>
</channel></rss>`;
