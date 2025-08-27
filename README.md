# Serra Nobre V3.0 — PWA + Vercel API + Firebase

## Conteúdo
- `index.html` — Pedidos com cálculo de frete via **/api/calcular-entrega** e **salvamento no Firestore**.
- `relatorios.html` — Relatórios (login fixo **Leo / 081008**) usando **Firebase Auth + Firestore**.
- `api/calcular-entrega.js` — Serverless Function (OpenRouteService) com faixas e isenção.
- `manifest.json`, `sw.js`, `icons/` — PWA básico.
- `.gitignore`, `feito-pelo-chatgpt.txt`.

## Vercel (API e Site)
- Importar repositório no Vercel (Other / sem build / sem output dir).
- Em **Settings → Environment Variables**:
  - `USE_PROVIDER=ors`
  - `ORS_API_KEY=...` (sua chave do OpenRouteService)
  - `ORIGIN_ADDRESS="Av. Bernardino Silveira Amorim 3695, Rubem Berta, Porto Alegre - RS, 91170-680"`
  - `TRANSPORT_PROFILE=driving-car`
  - `ISENCAO_NIVEL=1`
- Redeploy após salvar variáveis.

## Firebase (Auth + Firestore)
- Preencher `firebaseConfig` em **index.html** e **relatorios.html**.
- Authentication: habilitar **Email/Password**, criar `leo@serranobre.local` com senha **081008**.
- Authorized domains: adicionar o domínio da Vercel.
- Firestore Rules simples (exemplo):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthed() { return request.auth != null; }
    match /clientes/{docId} { allow read: if true; allow create, update: if isAuthed(); allow delete: if false; }
    match /historico_precos/{docId} { allow read: if true; allow create: if isAuthed(); allow update, delete: if false; }
    match /pedidos/{docId} { allow read: if isAuthed(); allow create: if isAuthed(); allow update, delete: if false; }
    match /{document=**} { allow read, write: if false; }
  }
}
```
- O `index.html` salva pedidos em `pedidos` com schema compatível.

## Observações
- O PDF mostra o **Frete** após forma de pagamento; se isento, aparece a etiqueta **(ISENTO DE FRETE)** e o valor cobrável não é somado.
- O logo é impresso **em tamanho dobrado** no PDF (80x30). Substitua `Serra-Nobre_3.png` pelo seu arquivo real (ou ajuste o caminho).
- Ícones do PWA são placeholders, troque por ícones reais.
