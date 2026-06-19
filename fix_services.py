import json, sys, shutil, openpyxl
sys.stdout.reconfigure(encoding='utf-8')

EXCEL = r"C:\Users\user\Desktop\ISOLA_Справочник_v2.xlsx"
DATA  = r"C:\Users\user\клод код\таблицы экзель\ISOLA_Business_Suite\isola-repo\data.json"

wb = openpyxl.load_workbook(EXCEL, data_only=True)
with open(DATA, 'r', encoding='utf-8-sig') as f:
    d = json.load(f)

# 1. Читаем 9 услуг из Excel
ws = wb['Услуги (подрядчики)']
excel_svcs = []
for r in range(3, ws.max_row + 1):
    name = str(ws.cell(r, 2).value or '').strip()
    if not name:
        continue
    excel_svcs.append({
        'name': name,
        'fio':  str(ws.cell(r, 3).value or '').strip() or '-',
        'ph':   str(ws.cell(r, 4).value or '').strip() or '-',
        'note': str(ws.cell(r, 5).value or '').strip() or '',
    })

# 2. Убираем ВСЕ service CP из data.json
d['cps'] = [c for c in d['cps'] if c['type'] != 'service']
print('Удалены все старые service CPs. Осталось CP:', len(d['cps']))

# 3. Добавляем чистый список с новыми ID
max_id = max(c['id'] for c in d['cps'])
for svc in excel_svcs:
    max_id += 1
    d['cps'].append({
        'id': max_id, 'n': svc['name'], 'org': svc['name'],
        'type': 'service', 'fio': svc['fio'], 'ph': svc['ph'], 'note': svc['note']
    })
    print('+' + str(max_id), svc['name'], '|', svc['note'])

tmp = DATA + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
shutil.move(tmp, DATA)

svc_count = sum(1 for c in d['cps'] if c['type'] == 'service')
print('Готово. Service CPs:', svc_count)
