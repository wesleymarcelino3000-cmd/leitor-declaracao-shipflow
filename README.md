# Leitor Declaração ShipFlow

Programa web/PWA para celular que usa a câmera apenas como visualização ao vivo, sem salvar foto, lê a declaração com OCR no navegador e conta etiquetas por descrição do produto.

## Funções

- Câmera ao vivo no celular
- Não captura nem salva imagem
- OCR local no navegador usando Tesseract.js
- Detecta declaração de conteúdo
- Extrai descrição do produto
- Tenta extrair rastreio para evitar duplicidade
- Soma quantas etiquetas existem por descrição
- Exporta CSV para abrir no Excel
- PWA instalável no celular
- Pronto para Cloudflare Pages

## Rodar localmente

```bash
npm install
npm run dev
```

## Cloudflare Pages

Configuração:

- Framework preset: Vite
- Build command: `npm run build`
- Build output directory: `dist`

O navegador só libera câmera em HTTPS ou localhost. No Cloudflare Pages funciona com HTTPS.
