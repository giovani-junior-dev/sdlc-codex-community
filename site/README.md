# Landing page SDLC Codex

HTML, CSS e JavaScript puros, sem instalação de dependências ou build. Na raiz do repositório:

```powershell
node site/serve.mjs
```

Abra http://127.0.0.1:4173. Para outra porta: `$env:PORT=4174` antes do comando. Ctrl+C encerra o servidor. O servidor é apenas para preview local; publique o conteúdo estático de `site/` no host escolhido quando houver autorização.

Também é possível abrir `index.html` diretamente; se o navegador bloquear o clipboard, a página seleciona o texto para cópia manual.

- `index.html`: conteúdo, changelog editorial, links e estrutura acessível.
- `styles.css`: layout responsivo, identidade e preferência por movimento reduzido.
- `hero-motion.css`: fábrica como background integral da hero, com contraste para o texto sobreposto.
- `app.js`: quatro etapas, dois formatos, cópia com feedback e menu mobile.
- `assets/factory.webp`: ilustração otimizada para a hero e poster do vídeo (96 KB). O PNG original fica no código-fonte. Não é uma captura do produto em execução.
- `assets/sdlc-codex-og-v1.jpg`: imagem de compartilhamento gerada por IA, 1200 × 630, JPEG (168 KB).
- `assets/factory-flow-loop.mp4`: sequência de 9,5 segundos gerada no Replicate: papéis entram pela esquerda, a máquina processa e uma aplicação sai à direita. Repetição contínua com dissolvência entre o final e o início, sem fade para preto e sem reproduzir ao contrário. O botão permite pausar; movimento reduzido usa só a imagem, sem carregar o vídeo. A reprodução pausa quando a hero sai da tela ou a aba fica oculta. `factory-motion.mp4` preserva a primeira versão, substituída por ter movimento insuficiente.
- `assets/logo.svg`: marca vetorial local.

Para atualizar uma release, edite o changelog em HTML e os comandos/prompts em app.js; mantenha o exemplo sem JavaScript em index.html sincronizado. Os links do GitHub apontam para o repositório Community público. Não há analytics, fontes remotas, serviço externo de runtime ou execução de comandos pela página.

O navegador usa apenas os assets locais. Nenhum token do Replicate é necessário para servir a página. Em falha de vídeo ou bloqueio de autoplay, a imagem continua visível.

## Cloudflare Pages

Projeto Direct Upload: `sdlc-codex`. Produção: https://sdlc-codex.pages.dev/.

Para publicar uma atualização com Wrangler autenticado, execute na raiz:

```powershell
$pagesOutput = node site/build.mjs
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
wrangler pages deploy $pagesOutput --project-name sdlc-codex --branch main --commit-dirty=true
```

O build copia somente os treze arquivos públicos da lista explícita em `build.mjs` para uma pasta temporária nova, incluindo SEO, página 404 e imagem de compartilhamento. Não inclui servidor local, README, PNG original, documentos internos ou arquivos do CLI. Direct Upload não configura publicação automática por Git: atualizações usam o comando acima. Domínio personalizado não configurado nesta publicação.

## SEO e compartilhamento

Canonical, Open Graph, Twitter Card e JSON-LD ficam no HTML inicial. A URL canônica é `https://sdlc-codex.pages.dev/`. Ao mudar o domínio, atualize também `robots.txt`, `sitemap.xml`, `llms.txt` e todas as URLs absolutas dos metadados.

O sitemap inclui somente a página canônica, sem fragmentos. Atualize `lastmod` quando houver mudança relevante no conteúdo. `404.html` evita o fallback de aplicação de página única para endereços inexistentes no Pages. `llms.txt` é um índice complementar experimental; não garante indexação nem citação por IA.

Use uma nova versão do nome da imagem OG ao trocar a thumb para reduzir problemas de cache nas plataformas. A imagem não é carregada na hero. Consulte [o registro de SEO](../docs/seo-launch.md) para escopo, evidências e acompanhamento.
