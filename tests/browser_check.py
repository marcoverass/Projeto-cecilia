"""Smoke test via Chrome DevTools Protocol; Python standard library only.

Start the app HTTP server and a dedicated browser with remote debugging first.
This script does not start or stop browsers and never uses your regular profile.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import time
import urllib.parse
import urllib.request


class DevTools:
    def __init__(self, websocket_url: str, origin: str):
        parsed = urllib.parse.urlsplit(websocket_url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), 15)
        self.sock.settimeout(15)
        self.buffer = b""
        self.seq = 0
        self.errors: list[dict] = []
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {parsed.path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"Origin: {origin}\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            response += self.sock.recv(4096)
        headers, self.buffer = response.split(b"\r\n\r\n", 1)
        expected = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
        ).digest())
        if b" 101 " not in headers or expected not in headers:
            raise RuntimeError("WebSocket recusado: " + headers.decode("latin-1"))

    def close(self):
        self.sock.close()

    def _exact(self, length: int) -> bytes:
        while len(self.buffer) < length:
            block = self.sock.recv(max(4096, length - len(self.buffer)))
            if not block:
                raise ConnectionError("O navegador encerrou a conexão de depuração.")
            self.buffer += block
        result, self.buffer = self.buffer[:length], self.buffer[length:]
        return result

    def _send(self, payload: bytes, opcode=1):
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header = bytes((0x80 | opcode, 0x80 | length))
        elif length < 65536:
            header = bytes((0x80 | opcode, 0xFE)) + struct.pack("!H", length)
        else:
            header = bytes((0x80 | opcode, 0xFF)) + struct.pack("!Q", length)
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _receive(self) -> dict:
        fragments = b""
        while True:
            first, second = self._exact(2)
            opcode, final = first & 0x0F, bool(first & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._exact(8))[0]
            mask = self._exact(4) if second & 0x80 else None
            payload = self._exact(length)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 8:
                raise ConnectionError("WebSocket fechado pelo navegador.")
            if opcode == 9:
                self._send(payload, 10)
                continue
            if opcode == 10:
                continue
            fragments += payload
            if final:
                return json.loads(fragments)

    def call(self, method: str, params: dict | None = None) -> dict:
        self.seq += 1
        message_id = self.seq
        self._send(json.dumps({"id": message_id, "method": method, "params": params or {}}).encode())
        while True:
            message = self._receive()
            if message.get("method") == "Runtime.exceptionThrown":
                self.errors.append(message["params"])
            if message.get("method") == "Runtime.consoleAPICalled" and message["params"].get("type") == "error":
                self.errors.append(message["params"])
            if message.get("id") != message_id:
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message.get("result", {})

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression, "awaitPromise": True, "returnByValue": True,
        })
        if "exceptionDetails" in result:
            raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False))
        return result.get("result", {}).get("value")

    def until(self, expression: str, timeout=15):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            value = self.evaluate(expression)
            if value:
                return value
            time.sleep(0.1)
        raise TimeoutError("Tempo excedido: " + expression)

    def navigate(self, url: str):
        self.call("Page.navigate", {"url": url})
        self.until("document.readyState === 'complete'")

    def screenshot(self, path: Path):
        result = self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        path.write_bytes(base64.b64decode(result["data"]))


def new_target(port: int):
    request = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


WORKFLOW_CHECK = r"""(async () => {
  const { LocalAdapter } = await import('./src/local.js');
  const memory = () => {
    const values = new Map();
    return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  };
  const app = new LocalAdapter({ storage: memory(), session: memory() });
  const checks = [];
  const expect = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const forbidden = async (fn, name) => {
    let error = null;
    try { await fn(); } catch (e) { error = e; }
    expect(!!error, name);
  };
  await app.demoLogin('helena');
  const baseline = await app.metrics();
  await app.demoLogin('cecilia');
  let snapshot = await app.createTicket({
    title: 'QA: permissao de pasta compartilhada', sectorId: 'ti', priority: 'high',
    description: 'O acesso a pasta compartilhada da equipe Comercial precisa ser corrigido.',
    attachments: [{ id: crypto.randomUUID(), name: 'detalhes.txt', type: 'text/plain', size: 3, data: 'data:text/plain;base64,YWJj' }],
  });
  let ticket = snapshot.tickets.find(t => t.title === 'QA: permissao de pasta compartilhada');
  const id = ticket.id;
  expect(ticket.status === 'open' && ticket.requesterId === 'cecilia' && ticket.requesterSectorId === 'comercial', 'Abertura, setor e anexo');
  expect(ticket.attachments.length === 1 && ticket.events.some(e => e.type === 'forwarded'), 'Encaminhamento automatico com historico');
  snapshot = await app.demoLogin('rafael');
  expect(snapshot.tickets.some(t => t.id === id) && snapshot.notifications.some(n => n.ticketId === id), 'Recebimento e notificacao do setor');
  await app.act(id, 'claim');
  await app.act(id, 'request_info', { text: 'Qual e a pasta e qual mensagem aparece?' });
  snapshot = await app.demoLogin('cecilia');
  expect(snapshot.tickets.find(t => t.id === id).status === 'waiting_info', 'Solicitacao de informacoes');
  await app.act(id, 'message', { text: 'Pasta Comercial, mensagem acesso negado.' });
  await app.demoLogin('rafael');
  await app.act(id, 'claim');
  await app.act(id, 'third_party', { text: 'Contato externo realizado por telefone.', thirdPartyName: 'Suporte de infraestrutura' });
  snapshot = await app.demoLogin('cecilia');
  expect(snapshot.notifications.some(n => n.ticketId === id && /terceiro/i.test(n.title)), 'Solicitante informado do terceiro');
  await app.demoLogin('rafael');
  await app.act(id, 'third_party_result', { text: 'O terceiro corrigiu a politica do servidor.' });
  await app.act(id, 'start_resolution');
  await app.act(id, 'resolve', { text: 'O grupo Comercial recebeu a permissao de leitura.' });
  snapshot = await app.act(id, 'submit');
  ticket = snapshot.tickets.find(t => t.id === id);
  expect(ticket.status === 'waiting_confirmation' && !ticket.closedAt, 'Resolucao aguarda aprovacao sem fim definitivo');
  await forbidden(() => app.act(id, 'approve'), 'Atendente nao pode aprovar pelo solicitante');
  await app.demoLogin('cecilia');
  await forbidden(() => app.act(id, 'reject', { text: ' ' }), 'Reprovacao exige motivo');
  snapshot = await app.act(id, 'reject', { text: 'Consigo ler, mas ainda preciso editar os arquivos.' });
  ticket = snapshot.tickets.find(t => t.id === id);
  expect(ticket.status === 'waiting_info' && ticket.reopenCount === 1 && !ticket.closedAt, 'Reprovacao reabre o atendimento com motivo');
  await app.demoLogin('rafael');
  await app.act(id, 'claim');
  await app.act(id, 'start_resolution');
  await app.act(id, 'resolve', { text: 'A permissao de edicao foi concedida ao grupo Comercial.' });
  await app.act(id, 'submit');
  await app.demoLogin('cecilia');
  snapshot = await app.act(id, 'approve');
  ticket = snapshot.tickets.find(t => t.id === id);
  expect(ticket.status === 'closed' && !!ticket.closedAt, 'Aprovacao registra fechamento definitivo');
  expect(ticket.events.filter(e => e.type === 'resolve').length === 2 && ticket.events.some(e => e.type === 'reject'), 'Historico preserva ambas as rodadas');
  expect(ticket.events.every(e => !!e.actorId && !!e.actorName && !!e.at), 'Eventos possuem autor e data');
  await forbidden(() => app.act(id, 'message', { text: 'Nova mensagem' }), 'Finalizado nao recebe novas mensagens');
  await forbidden(() => app.metrics(), 'Indicadores bloqueados para solicitante');
  await app.demoLogin('rafael');
  await forbidden(() => app.act(id, 'claim'), 'Finalizado nao pode ser retomado');
  snapshot = await app.demoLogin('helena');
  expect(!snapshot.tickets.some(t => t.id === id), 'Gestao recebe indicadores sem expor chamados individuais');
  const metrics = await app.metrics();
  expect(metrics.total === baseline.total + 1 && metrics.finalized === baseline.finalized + 1, 'Dashboard reflete criacao e finalizacao');
  expect(metrics.thirdPartyCount === baseline.thirdPartyCount + 1 && metrics.reopenedCount === baseline.reopenedCount + 1, 'Dashboard contabiliza terceiros e reaberturas');
  const ti = await app.metrics({ sectorId: 'ti' });
  expect(ti.bySector.every(s => s.sectorId === 'ti') && ti.total <= metrics.total, 'Filtro gerencial por setor');
  return { passed: checks.length, failed: 0, checks, code: ticket.code, eventCount: ticket.events.length };
})()"""


def run(args) -> dict:
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    report = {"checks": [], "failures": [], "screenshots": [], "consoleErrors": []}
    target = new_target(args.port)
    browser = DevTools(target["webSocketDebuggerUrl"], f"http://127.0.0.1:{args.port}")

    def record(name, passed, details=None):
        report["checks"].append({"name": name, "passed": bool(passed), "details": details})
        if not passed:
            report["failures"].append(name)

    def capture(name):
        browser.until("!document.querySelector('#toast-root .toast')", timeout=8)
        browser.screenshot(output / name)
        report["screenshots"].append(name)

    def click(selector):
        browser.until(f"!!document.querySelector({json.dumps(selector)})")
        browser.evaluate(f"document.querySelector({json.dumps(selector)}).click()")

    def fill(selector, values):
        browser.evaluate("""((selector, values) => {
          const form = document.querySelector(selector);
          if (!form) throw new Error('Formulario nao encontrado: ' + selector);
          for (const [name, value] of Object.entries(values)) {
            const input = form.elements.namedItem(name);
            if (!input) throw new Error('Campo nao encontrado: ' + name);
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })""" + f"({json.dumps(selector)}, {json.dumps(values)})")

    def submit(selector):
        browser.evaluate(f"document.querySelector({json.dumps(selector)}).requestSubmit()")

    def switch_user(user_id):
        click('[data-profile]')
        click(f'[data-demo-user="{user_id}"]')
        browser.until("!document.querySelector('#dialog-root')?.firstChild && !!document.querySelector('.shell')")
        name = {"cecilia": "Cec", "rafael": "Rafael", "helena": "Helena"}[user_id]
        browser.until(f"document.querySelector('.user-control strong')?.textContent.includes({json.dumps(name)})")

    def open_ticket(ticket_id):
        browser.evaluate(f"location.hash = '#/ticket/' + encodeURIComponent({json.dumps(ticket_id)})")
        browser.until("!!document.querySelector('.detail-heading')")

    def ticket_status(expected):
        browser.until(f"!!document.querySelector('.detail-heading .pill.{expected}')")

    def action(name, expected, text=None, third_party=None):
        click(f'[data-action="{name}"]')
        if name not in {"claim", "start_resolution", "submit"}:
            browser.until("!!document.querySelector('[data-form=action]')")
            values = {}
            if text is not None:
                values["text"] = text
            if third_party is not None:
                values["thirdPartyName"] = third_party
            fill('[data-form="action"]', values)
            submit('[data-form="action"]')
            browser.until("!document.querySelector('[data-form=action]')")
        ticket_status(expected)

    def ui_workflow():
        switch_user("cecilia")
        capture("04-visao-geral-cecilia-desktop.png")
        click('[data-new-ticket]')
        browser.until("!!document.querySelector('[data-form=new-ticket]')")
        title = "QA navegador: acesso a pasta Comercial"
        fill('[data-form="new-ticket"]', {
            "title": title, "sectorId": "ti", "priority": "high",
            "description": "A pasta compartilhada da equipe Comercial apresenta acesso negado.",
        })
        browser.evaluate("""(() => {
          const upload = document.querySelector('[data-upload]');
          const transfer = new DataTransfer();
          transfer.items.add(new File(['abc'], 'detalhes-qa.txt', {type: 'text/plain'}));
          upload.files = transfer.files;
          upload.dispatchEvent(new Event('change', { bubbles: true }));
        })()""")
        submit('[data-form="new-ticket"]')
        browser.until(f"document.querySelector('.detail-heading h1')?.textContent === {json.dumps(title)}")
        ticket_id = browser.evaluate("decodeURIComponent(location.hash.split('/').at(-1))")
        ticket_status("open")
        record("DOM: abertura com anexo", browser.evaluate("document.querySelector('.attachment strong')?.textContent === 'detalhes-qa.txt'"))

        switch_user("rafael")
        click('[data-nav="sector"]')
        browser.until("document.querySelector('.page-heading h1')?.textContent.includes('Chamados do setor')")
        capture("05-chamados-setor-rafael-desktop.png")
        open_ticket(ticket_id)
        action("claim", "in_progress")
        action("request_info", "waiting_info", "Qual pasta apresenta o problema e qual mensagem aparece?")
        switch_user("cecilia")
        open_ticket(ticket_id)
        fill('[data-form="message"]', {"text": "Pasta Comercial, mensagem acesso negado."})
        submit('[data-form="message"]')
        browser.until("document.querySelector('.timeline')?.textContent.includes('Pasta Comercial, mensagem acesso negado.')")
        ticket_status("waiting_info")

        switch_user("rafael")
        open_ticket(ticket_id)
        action("claim", "in_progress")
        action("third_party", "third_party", "Contato realizado por telefone pelo setor.", "Assistencia de infraestrutura")
        action("third_party_result", "in_progress", "A politica do servidor foi corrigida pelo terceiro.")
        action("start_resolution", "resolving")
        action("resolve", "resolved", "O grupo Comercial recebeu permissao de leitura.")
        action("submit", "waiting_confirmation")
        capture("06-detalhe-rafael-desktop.png")
        record("DOM: atendente nao aprova solucao", not browser.evaluate("!!document.querySelector('[data-action=approve]')"))

        switch_user("cecilia")
        open_ticket(ticket_id)
        click('[data-action="reject"]')
        submit('[data-form="action"]')
        record("DOM: reprovacao sem motivo bloqueada", browser.evaluate("!!document.querySelector('[data-form=action]') && !document.querySelector('[data-form=action]').checkValidity()"))
        fill('[data-form="action"]', {"text": "Consigo ler, mas ainda preciso editar os documentos."})
        submit('[data-form="action"]')
        browser.until("!document.querySelector('[data-form=action]')")
        ticket_status("waiting_info")
        switch_user("rafael")
        open_ticket(ticket_id)
        action("claim", "in_progress")
        action("resolve", "resolved", "A permissao de edicao foi concedida ao grupo Comercial.")
        action("submit", "waiting_confirmation")
        switch_user("cecilia")
        open_ticket(ticket_id)
        action("approve", "closed")
        record("DOM: aprovacao finaliza e bloqueia operacoes", browser.evaluate("!!document.querySelector('.closed-note') && !document.querySelector('[data-form=message]') && !document.querySelector('[data-action]')"))
        record("DOM: historico completo permanece visivel", browser.evaluate("document.querySelectorAll('.timeline-event').length >= 15"))
        report["uiTicketId"] = ticket_id

        switch_user("helena")
        click('[data-nav="metrics"]')
        browser.until("document.querySelector('#metrics-results') && !document.querySelector('#metrics-results .page-loading')")
        capture("07-indicadores-helena-desktop.png")
        fill('[data-form="metrics"]', {"sectorId": "ti"})
        submit('[data-form="metrics"]')
        browser.until("document.querySelector('#metrics-results') && !document.querySelector('#metrics-results .page-loading')")
        record("DOM: filtros do dashboard", browser.evaluate("document.querySelector('#metric-sector').value === 'ti' && document.querySelector('#metrics-results').textContent.length > 100"))
        record("DOM: diretoria nao possui fila de atendimento", not browser.evaluate("!!document.querySelector('[data-nav=sector]')"))
        switch_user("cecilia")
        return ticket_id

    try:
        browser.call("Page.enable")
        browser.call("Runtime.enable")
        browser.call("Emulation.setDeviceMetricsOverride", {
            "width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False,
        })
        browser.navigate(args.url.rstrip("/") + "/tests/domain.html")
        tests = browser.until("window.__TEST_RESULTS__ || null", timeout=30)
        report["domain"] = tests
        record("Testes de domínio", tests.get("failed", 0) == 0 and tests.get("passed", 0) > 0, tests)

        browser.errors = []
        browser.navigate(args.url)
        browser.until("!!(document.querySelector('[data-demo-user]') || document.querySelector('[data-nav]'))")
        record("Idioma português", browser.evaluate("document.documentElement.lang.toLowerCase().startsWith('pt')"))
        record("Sem rolagem horizontal no desktop", browser.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
        capture("01-entrada-desktop.png")

        logged = browser.evaluate("""(() => {
          const buttons = [...document.querySelectorAll('[data-demo-user]')];
          if (!buttons.length) return false;
          const button = buttons.find(b => /Rafael|atendente/i.test(b.textContent)) || buttons[0];
          button.click(); return true;
        })()""")
        if logged:
            browser.until("!!document.querySelector('[data-nav]')")
        record("Navegação autenticada", browser.evaluate("!!document.querySelector('[data-nav]')"))
        browser.evaluate("document.fonts.ready.then(() => true)")
        capture("02-chamados-desktop.png")

        workflow = browser.evaluate(WORKFLOW_CHECK)
        report["workflow"] = workflow
        record("Ciclo completo entre solicitante, atendente e gestao", workflow.get("failed", 0) == 0, workflow)

        ticket_id = ui_workflow()

        navigation = browser.evaluate("[...document.querySelectorAll('[data-nav]')].map(e => ({view:e.dataset.nav,text:e.textContent.trim()}))")
        report["navigation"] = navigation

        browser.call("Emulation.setDeviceMetricsOverride", {
            "width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True,
        })
        browser.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        record("Sem rolagem horizontal no celular", browser.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
        capture("03-chamados-celular.png")
        open_ticket(ticket_id)
        record("Sem rolagem horizontal no detalhe no celular", browser.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
        capture("08-detalhe-cecilia-celular.png")
        record("Zoom permitido", browser.evaluate("!(/user-scalable\\s*=\\s*no|maximum-scale\\s*=\\s*1(?:[,.]|$)/i).test(document.querySelector('meta[name=viewport]')?.content || '')"))

        browser.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
        record("Preferência de movimento reduzido reconhecida", browser.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"))
        browser.evaluate("true")
        report["consoleErrors"] = browser.errors
        record("Sem erros JavaScript no app", not browser.errors, browser.errors)
    except Exception as exc:
        report["failures"].append(str(exc))
        report["exception"] = repr(exc)
        try:
            report["failureLocation"] = browser.evaluate("location.href")
            report["visibleErrors"] = browser.evaluate("[...document.querySelectorAll('[data-form-error], .toast.error')].filter(e => !e.hidden).map(e => e.textContent)")
            report["consoleErrors"] = browser.errors
            capture("99-falha.png")
        except Exception:
            pass
    finally:
        browser.close()
        report["passed"] = not report["failures"]
        (output / "browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9222)
    parser.add_argument("--url", default="http://127.0.0.1:4173")
    parser.add_argument("--output", default="artifacts")
    args = parser.parse_args()
    report = run(args)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
