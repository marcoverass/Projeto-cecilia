# Entre setores

Aplicação web em português para centralizar solicitações entre os setores da empresa, conforme o documento **Sistema de Solicitações Internas.pdf**. Interface responsiva, tipografia do sistema, navegação por perfil e feedback discreto inspirados nos princípios de design da Apple.

HTML, CSS e JavaScript nativos: não exige Node, npm, compilação ou domínio próprio. Os caminhos relativos permitem publicar em um subdiretório do GitHub Pages.

**Site publicado:** [Abrir Entre setores](https://marcoverass.github.io/Projeto-cecilia/). Repositório: [marcoverass/Projeto-cecilia](https://github.com/marcoverass/Projeto-cecilia). O Pages está ativo, sem domínio próprio. O repositório permanece privado e o site é acessível pelo link.

## Executar no computador

Abra o terminal na pasta do projeto e execute:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Acesse **http://127.0.0.1:4173** no navegador. Use um servidor HTTP; abrir `index.html` diretamente não permite carregar módulos JavaScript corretamente.

## Demonstração e uso real

Sem a configuração de produção, a tela de entrada oferece perfis de demonstração identificados. Os dados fictícios e as alterações ficam neste navegador. As identidades de demonstração servem para conhecer e testar os fluxos; não constituem autenticação nem compartilham dados entre computadores.

O modo de produção utiliza **Supabase Auth e PostgreSQL**, com acesso validado no servidor. O GitHub Pages hospeda os arquivos do site; ele não fornece servidor de aplicação ou banco de dados. Para ativar o uso real, siga [docs/PRODUCAO.md](docs/PRODUCAO.md): executar o esquema SQL, provisionar contas e perfis e preencher `config.js` com a URL do projeto e sua chave pública. Nunca coloque uma chave `service_role`, senha de banco ou token do GitHub em arquivos do site.

O ambiente publicado está em demonstração, pois ainda não existe um projeto Supabase configurado. O código para o uso real e o esquema do banco estão incluídos; a demonstração não compartilha dados entre computadores.

## Publicar sem domínio no GitHub Pages

1. Envie os arquivos deste projeto para a branch `main` do repositório [marcoverass/Projeto-cecilia](https://github.com/marcoverass/Projeto-cecilia), mantendo a pasta `.github`.
2. No repositório, abra **Settings → Pages → Build and deployment → Source** e selecione **GitHub Actions**.
3. Abra **Actions → Publicar no GitHub Pages** e execute o workflow, ou envie um novo commit para `main`.
4. Após a conclusão, o job informa a URL `github.io` do site. Não é necessário configurar domínio.

O workflow publica somente `index.html`, `styles.css`, `config.js`, `manifest.webmanifest`, `favicon.svg` e `src/`. Documentação, testes, artefatos de QA e SQL ficam fora do site publicado. Se o repositório for público, seus arquivos de origem continuam visíveis no GitHub; não envie dados de usuários ou segredos.

As versões das ações seguem o [exemplo oficial de publicação do GitHub](https://docs.github.com/en/get-started/start-your-journey/deploying-your-website-automatically).

## Fluxos contemplados

- Solicitante: abrir vários chamados simultaneamente, acompanhar os próprios pedidos, enviar mensagens e anexos, responder a pedidos de informações e aprovar ou reprovar a solução.
- Atendente: receber chamados do seu setor, assumir o atendimento, solicitar informações, registrar terceiros e seus resultados, registrar a resolução e encaminhar para confirmação.
- Diretor/gestor: acompanhar indicadores agregados por setor e período, sem acesso automático ao conteúdo de chamados de outros usuários.
- Histórico com autoria, data e hora dos eventos e notificações internas para os envolvidos.
- Fechamento definitivo somente após aprovação do solicitante. A reprovação exige justificativa e retorna ao fluxo de atendimento.
- Indicadores calculados a partir dos eventos: volumes, primeira resposta, resolução, finalização, terceiros, reaberturas e espera pela aprovação.

O contato com terceiros acontece fora do sistema. Integrações com WhatsApp, ERP, pagamentos, atendimento ao público e resolução automática por IA não fazem parte do escopo.

Consulte a rastreabilidade em [docs/REQUISITOS.md](docs/REQUISITOS.md) e a implantação em [docs/PRODUCAO.md](docs/PRODUCAO.md).

## Validação realizada

Em 30/10/2026, a versão foi verificada no Chrome com 23 testes do domínio, 19 verificações do ciclo de atendimento e 17 verificações de interface, incluindo o fluxo pelas telas, anexos, os três perfis e dimensões de celular. Nenhum erro JavaScript foi registrado.

O esquema SQL e o adaptador de autenticação passaram por 47 verificações em [tests/backend.html](tests/backend.html), usando PostgreSQL 18 em memória via [PGlite](https://pglite.dev/docs/), com identidades de teste. Esse teste requer internet e carrega PGlite 0.5.13 de um CDN; o aplicativo publicado não depende desse pacote. O projeto Supabase real ainda precisa ser criado e configurado pelo responsável, conforme o guia de produção. Toque, teclado e áreas seguras devem ser conferidos em um celular físico.

## Verificação no navegador

Com o servidor local em execução, abra **http://127.0.0.1:4173/tests/domain.html** para executar os testes do domínio. Eles verificam as permissões, transições do chamado e cálculo de indicadores.

O script `tests/browser_check.py` também executa os testes no Chrome/Edge por meio do protocolo de depuração do navegador, sem dependências Python adicionais. Primeiro inicie uma **instância de teste**, com uma pasta de perfil exclusiva e uma porta de depuração local. Exemplo em PowerShell:

```powershell
$browser = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:TEMP 'solicitacoes-browser-qa'
Start-Process -FilePath $browser -WindowStyle Hidden -ArgumentList @('--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--remote-allow-origins=http://127.0.0.1:9222', "--user-data-dir=$profile", 'about:blank')
python tests/browser_check.py --port 9222 --url http://127.0.0.1:4173 --output artifacts
```

Se usar Edge, altere `$browser` para `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. O script grava capturas da entrada, do app no desktop e do app em tamanho de celular, além de um relatório JSON. Os artefatos não entram no GitHub Pages. Feche a instância de teste ao terminar. Verificações em tamanho de celular não substituem testes de toque, teclado e área segura em um aparelho real.
