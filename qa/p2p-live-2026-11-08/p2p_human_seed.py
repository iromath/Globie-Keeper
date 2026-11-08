import json, sys, time, urllib.request, urllib.error, uuid

BASE = 'https://keeperapi.globie.ai/api'
ORIGIN = 'https://keeper.globie.ai'
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')

PEOPLE = [
    ('Nattapong Sirichai', 'nattapong.sirichai@example.com'),
    ('Malee Wongsuwan', 'malee.wongsuwan@example.com'),
    ('Kittipong Arun', 'kittipong.arun@example.com'),
    ('Suda Panyarat', 'suda.panyarat@example.com'),
]


def call(method, path, token=None, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (
        json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('origin', ORIGIN)
    req.add_header('user-agent', UA)
    if data is not None:
        req.add_header('content-type', ctype)
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else {})
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt


def must(label, res):
    s, p = res
    print(f'{label} -> {s}: {json.dumps(p, ensure_ascii=False)[:220]}')
    if s >= 300:
        sys.exit(f'FAILED at {label}')
    return p


def upload(bill_id, token):
    boundary = '----qa' + uuid.uuid4().hex
    data = open('/tmp/qa-receipt.png', 'rb').read()
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nphoto\r\n'.encode()
            + f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\n'
              f'Content-Type: image/png\r\n\r\n'.encode() + data + b'\r\n'
            + f'--{boundary}--\r\n'.encode())
    return call('POST', f'/bills/{bill_id}/media', token=token, raw=body,
                ctype=f'multipart/form-data; boundary={boundary}')


sessions = {}
for name, email in PEOPLE:
    s = must(f'login {name}', call('POST', '/auth/session',
                                   body={'email': email, 'displayName': name}))
    sessions[name] = {'token': s['token'], 'userId': s['userId'], 'email': email}

payee_name = PEOPLE[0][0]
payee = sessions[payee_name]
payee_tok = payee['token']

created = must('create group', call('POST', '/groups', token=payee_tok,
                                    body={'name': 'Friday dinner at Openmind Kitchen',
                                          'currency': 'THB'}))
group_id = created['group']['id']
invite = created['group']['inviteToken']
members = {payee_name: created['member']['id']}

for name, _email in PEOPLE[1:]:
    joined = must(f'join {name}', call('POST', '/groups/join', token=sessions[name]['token'],
                                       body={'inviteToken': invite, 'displayName': name}))
    members[name] = joined['member']['id']

must('payee paypal settings', call('PATCH', '/me', token=payee_tok,
                                  body={'paypalMode': 'paypal_me',
                                        'paypalMeHandle': 'openmindprojects'}))

ag = must('agreement', call('POST', '/agreements', token=payee_tok,
                            body={'groupId': group_id, 'estimatedTotalMinor': 121980}))
aid = ag['agreement']['id']
for name, _email in PEOPLE:
    must(f'accept {name}', call('POST', f'/agreements/{aid}/accept',
                                token=sessions[name]['token']))

b = must('bill', call('POST', '/bills', token=payee_tok,
                      body={'agreementId': aid, 'currency': 'THB'}))
bill_id = b['bill']['id']
must('upload', upload(bill_id, payee_tok))
must('parse', call('POST', f'/bills/{bill_id}/parse', token=payee_tok))

d = {}
for _ in range(60):
    time.sleep(1.5)
    s, d = call('GET', f'/bills/{bill_id}', token=payee_tok)
    if d.get('bill', {}).get('status') != 'PARSING':
        break
items = d.get('bill', {}).get('items', [])
print('parsed', d['bill']['status'], len(items), 'items total', d['bill']['totalMinor'])
if not items:
    sys.exit('parse produced no items')

alloc = [{'billItemId': i['id'], 'memberId': m, 'qty': 1}
         for i in items for m in members.values()]
al = must('allocate', call('PATCH', f'/bills/{bill_id}/allocations', token=payee_tok,
                           body={'allocations': alloc}))

by_member = {mid: name for name, mid in members.items()}
for row in al['allocations']:
    name = by_member[row['memberId']]
    must(f'confirm {name}', call('POST', f"/allocations/{row['id']}/confirm",
                                 token=sessions[name]['token']))

fin = must('finalize', call('POST', f'/bills/{bill_id}/finalize', token=payee_tok))
req = must('request payments', call('POST', f'/bills/{bill_id}/request-payments',
                                    token=payee_tok))

links = {r['shareId']: r for r in req.get('requests', [])}
shares = []
for sh in fin['shares']:
    name = by_member.get(sh['memberId'], '?')
    link = links.get(sh['id'], {})
    shares.append({'shareId': sh['id'], 'member': name,
                   'amountMinor': sh['amountMinor'], 'status': sh['status'],
                   'approveUrl': link.get('approveUrl')})

state = {'groupId': group_id, 'billId': bill_id, 'totalMinor': d['bill']['totalMinor'],
         'currency': d['bill']['currency'], 'inviteToken': invite,
         'members': members, 'sessions': sessions, 'shares': shares,
         'billStatus': req.get('bill', {}).get('status')}
json.dump(state, open('/tmp/p2p_human_state.json', 'w'), indent=1)
print('\nSTATE')
print(json.dumps({k: v for k, v in state.items() if k != 'sessions'}, indent=1,
                 ensure_ascii=False))
