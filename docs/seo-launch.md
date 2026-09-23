# SEO e compartilhamento — 22/09/2026

## Escopo e decisões

Público: desenvolvedores e alunos de língua portuguesa que querem organizar sessões Codex no Windows. Intenções atendidas: orquestração de agentes Codex, comunicação entre sessões, instalação do SDLC Codex e requisitos do Herdr. Não houve pesquisa de volume de palavras-chave nem acesso a métricas do Search Console.

Antes: título genérico, sem canonical, Open Graph, Twitter Card, sitemap, robots.txt ou JSON-LD; poster PNG de 1.632.139 bytes. O tutorial já tinha links para documentação e ferramentas oficiais.

Implementado: título e descrição específicos, canonical HTTPS, metadados sociais completos com imagem absoluta e texto alternativo, JSON-LD estático WebSite/WebPage/SoftwareSourceCode, autoria visível e perguntas frequentes sobre definição, instalação e licença. O conteúdo principal pode ser lido sem JavaScript. Sem avaliações inventadas, meta keywords, páginas artificiais ou promessas de resultados enriquecidos.

`robots.txt` permite rastreamento e aponta para o sitemap; isso não substitui eventuais regras de bots ou firewall no Cloudflare. `llms.txt` resume informações públicas e links oficiais do projeto; é complementar e experimental. `404.html` permite ao Pages responder 404 em rotas inexistentes, evitando soft 404.

## Imagens

- OG: `site/assets/sdlc-codex-og-v1.jpg`, 1200 × 630, 168.246 bytes. Geração pelo recurso integrado image_gen, sem credenciais em arquivos do projeto. JPEG derivado com FFmpeg para adequação de dimensões e peso.
- Hero: `site/assets/factory.webp`, 96.430 bytes, redução de aproximadamente 94% em relação ao PNG original. O vídeo permanece igual. Isso mede bytes, não Core Web Vitals em campo.
- Prompt da geração: “Create a finished premium Open Graph social sharing thumbnail for SDLC Codex, landscape 1200x630 (1.905:1). Use case ads-marketing. Design consistent with a dark charcoal (#141718) website with electric lime green accents. Beautiful isometric miniature software factory occupying the right 55% and lower right: paper specification enters on a conveyor belt from left, central machine has five small connected terminal panels representing collaborating coding agents, finished desktop application emerges on the right. Subtle precise technical illustration, dimensional matte metal, restrained lime lights, no people, no OpenAI logo. Left 45% clear negative space with large crisp white typography exact text 'SDLC Codex', below smaller exact Portuguese text 'Uma equipe de agentes.' and 'Do plano ao aplicativo.' Small lime badge 'OPEN SOURCE · MIT'. High legibility when reduced to phone thumbnail. All text and main subjects at least 65px from edges, no tiny illegible UI text, no watermark. Render complete image including typography. Save generated output for use as a website image asset.”

## Validação local executada

- `npm run typecheck`: aprovado. `npm test`: 602 aprovados, zero falhas, um skip. `npm run test:live`: quatro skips, sem efeitos externos.
- Navegador em 1440, 390 e 320 pixels: sem transbordamento horizontal, sem erros de JavaScript, um H1 e nenhuma âncora interna quebrada. Tutorial de instalação continua apontando para o Community.
- JSON-LD parseado no navegador; metadados e FAQ presentes no HTML inicial. Não foi executado o validador externo de resultados enriquecidos do Google.
- Imagem decodificada em 1200 × 630. Imagem, WebP, robots, sitemap e llms respondem 200 no preview; XML do sitemap válido, com uma URL canônica.
- Build concluído, `git diff --check` aprovado e Gitleaks sem achados nos arquivos que serão publicados.

## Acompanhamento após publicação

- Verificar a propriedade no Google Search Console e Bing Webmaster Tools com a conta do mantenedor e enviar `https://sdlc-codex.pages.dev/sitemap.xml`. Nenhum token de verificação foi inventado ou inserido.
- Acompanhar indexação, consultas, cliques e Core Web Vitals quando houver dados suficientes. Ainda não há evidência de ranking, tráfego orgânico ou citações por IA.
- Testar o link no aplicativo de compartilhamento usado pelos alunos. A plataforma controla o cache e a apresentação final da prévia.
- JSON-LD descreve o projeto e sua fonte; não afirma elegibilidade a estrelas ou resultados enriquecidos de aplicativo. Validar novamente ao mudar o conteúdo.

## Referências primárias

- [Google: recursos de IA e seu site](https://developers.google.com/search/docs/appearance/ai-features)
- [Google: políticas de dados estruturados](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [Open Graph Protocol](https://ogp.me/)
- [Schema.org: SoftwareSourceCode](https://schema.org/SoftwareSourceCode)
