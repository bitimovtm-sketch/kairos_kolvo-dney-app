// ============================================================================
// Приложение "Дни на стадии" для Bitrix24 (kairos-dv.bitrix24.ru)
//
// Создаёт ОДНО поле только для просмотра — и в Лидах, и в Сделках.
// Поле показывает две цифры сразу, например: "3 из 5"
//   (сколько дней уже на стадии) из (сколько дней заложено на стадию)
//
// Источники значений:
//   Лиды:   заложено UF_CRM_1787027189, прошло UF_CRM_1787027204
//   Сделки: заложено UF_CRM_1787027221, прошло UF_CRM_1787027233
//
// Установка идемпотентна: можно запускать повторно.
// ============================================================================

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Входящий вебхук для ЧТЕНИЯ значений (Разработчикам -> Другое -> Входящий вебхук, права crm)
// Railway -> Variables -> KOLVO_DNEY_WEBHOOK
const READ_WEBHOOK = process.env.KOLVO_DNEY_WEBHOOK;

// --- Настройка ---------------------------------------------------------------
const USER_TYPE_ID = 'stage_days';
const FIELD_NAME = 'STAGE_DAYS';
const FIELD_LABEL = 'Дни на стадии';

// Какие поля откуда брать
const SOURCE = {
  CRM_LEAD: { plan: 'UF_CRM_1787027189', fact: 'UF_CRM_1787027204' },
  CRM_DEAL: { plan: 'UF_CRM_1787027221', fact: 'UF_CRM_1787027233' },
};

const GET_METHOD = {
  CRM_LEAD: 'crm.lead.get',
  CRM_DEAL: 'crm.deal.get',
};

// ---------------------------------------------------------------------------
// Установка приложения
// ---------------------------------------------------------------------------

app.post('/install', async (req, res) => {
  console.log('INSTALL request body:', JSON.stringify(req.body));

  const SERVER_ENDPOINT = req.body.SERVER_ENDPOINT || req.body?.auth?.server_endpoint;
  const AUTH_ID = req.body.AUTH_ID || req.body?.auth?.access_token;

  if (!AUTH_ID) {
    console.log('INSTALL: не хватает AUTH_ID');
    return res.send(installFinishHtml('Не хватает данных установки. Обновите страницу и попробуйте снова.'));
  }

  // Реальный адрес портала берём из Referer — он надёжнее SERVER_ENDPOINT
  const referer = req.headers.referer || req.headers.referrer || '';
  const refererMatch = referer.match(/^https?:\/\/([^/]+)/);
  const restUrl = refererMatch ? `https://${refererMatch[1]}/rest/` : SERVER_ENDPOINT;

  console.log('INSTALL using restUrl:', restUrl);

  const log = [];
  const handlerUrl = `https://${req.get('host')}/widget`;

  // 1. Регистрируем или обновляем тип поля
  try {
    await callBitrix(restUrl, AUTH_ID, 'userfieldtype.add', {
      USER_TYPE_ID,
      HANDLER: handlerUrl,
      TITLE: FIELD_LABEL,
      DESCRIPTION: 'Только отображение значения, без редактирования',
      OPTIONS: { height: 24 },
    });
    log.push('Тип поля зарегистрирован.');
  } catch (e) {
    try {
      await callBitrix(restUrl, AUTH_ID, 'userfieldtype.update', {
        USER_TYPE_ID,
        HANDLER: handlerUrl,
        TITLE: FIELD_LABEL,
        OPTIONS: { height: 24 },
      });
      log.push('Тип поля обновлён.');
    } catch (e2) {
      log.push(`Тип поля: ${e2.message}`);
    }
  }

  // 2. Определяем настоящий код типа (rest_<ID приложения>_<наш код>)
  const realTypeId = await resolveTypeId(restUrl, AUTH_ID, log);

  if (realTypeId) {
    // 3. Создаём или обновляем поля
    await ensureField(restUrl, AUTH_ID, 'lead', realTypeId, log, 'Лидах');
    await ensureField(restUrl, AUTH_ID, 'deal', realTypeId, log, 'Сделках');
  }

  console.log('Установка завершена:', log.join(' | '));
  res.send(installFinishHtml(log.join('<br>')));
});

app.get('/install', (req, res) => {
  res.send(installFinishHtml('Приложение уже установлено.'));
});

async function resolveTypeId(restUrl, authId, log) {
  try {
    const types = await callBitrix(restUrl, authId, 'userfieldtype.list', {});
    const list = Array.isArray(types) ? types : Object.values(types || {});
    const found = list.find((t) => String(t.USER_TYPE_ID || '').endsWith(USER_TYPE_ID));
    if (found) return found.USER_TYPE_ID;
  } catch (e) {
    console.log('userfieldtype.list ошибка:', e.message);
  }

  // Запасной способ — собрать код из ID приложения
  try {
    const info = await callBitrix(restUrl, authId, 'app.info', {});
    if (info && info.ID) return `rest_${info.ID}_${USER_TYPE_ID}`;
  } catch (e) {
    log.push(`Не удалось определить код типа: ${e.message}`);
    return null;
  }

  log.push('Код типа не определён, поля не созданы.');
  return null;
}

async function ensureField(restUrl, authId, entity, typeId, log, humanName) {
  const fullName = `UF_CRM_${FIELD_NAME}`;

  try {
    const existing = await callBitrix(restUrl, authId, `crm.${entity}.userfield.list`, {
      filter: { FIELD_NAME: fullName },
    });
    const list = Array.isArray(existing) ? existing : Object.values(existing || {});

    if (list.length > 0) {
      await callBitrix(restUrl, authId, `crm.${entity}.userfield.update`, {
        id: list[0].ID,
        fields: {
          LABEL: FIELD_LABEL,
          EDIT_FORM_LABEL: { ru: FIELD_LABEL },
          LIST_COLUMN_LABEL: { ru: FIELD_LABEL },
        },
      });
      log.push(`Поле в ${humanName}: обновлено.`);
      return;
    }

    await callBitrix(restUrl, authId, `crm.${entity}.userfield.add`, {
      fields: {
        FIELD_NAME,
        USER_TYPE_ID: typeId,
        LABEL: FIELD_LABEL,
        EDIT_FORM_LABEL: { ru: FIELD_LABEL },
        LIST_COLUMN_LABEL: { ru: FIELD_LABEL },
      },
    });
    log.push(`Поле в ${humanName}: создано.`);
  } catch (e) {
    log.push(`Поле в ${humanName}: ${e.message}`);
  }
}

async function callBitrix(restUrl, authId, method, fields) {
  try {
    const response = await axios.post(`${restUrl}${method}`, fields, {
      params: { auth: authId },
    });
    if (response.data.error) {
      throw new Error(response.data.error_description || response.data.error);
    }
    return response.data.result;
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(detail);
  }
}

function installFinishHtml(message) {
  return `<!DOCTYPE html>
<html>
<head><script src="//api.bitrix24.com/api/v1/"></script></head>
<body style="font-family:Arial,sans-serif;padding:20px;">
  <p>${message}</p>
  <p>Можно закрыть это окно.</p>
  <script>
    BX24.init(function () {
      BX24.installFinish();
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Отображение поля на карточке (только просмотр)
// ---------------------------------------------------------------------------

app.all('/widget', async (req, res) => {
  try {
    const raw = req.body && req.body.PLACEMENT_OPTIONS
      ? JSON.parse(req.body.PLACEMENT_OPTIONS)
      : { ...req.query, ...req.body };

    const entityId = raw.ENTITY_ID;
    const itemId = raw.ENTITY_VALUE_ID;

    const method = GET_METHOD[entityId];
    const source = SOURCE[entityId];

    if (!method || !source || !itemId || !READ_WEBHOOK) {
      return res.send(renderHtml('—'));
    }

    const response = await axios.get(`${READ_WEBHOOK}${method}`, {
      params: { id: itemId },
    });

    const item = response.data?.result || {};
    const fact = clean(item[source.fact]);
    const plan = clean(item[source.plan]);

    let text;
    if (fact === null && plan === null) {
      text = '—';
    } else if (plan === null) {
      text = String(fact);
    } else if (fact === null) {
      text = `— из ${plan}`;
    } else {
      // Если срок превышен — подсвечиваем красным
      const over = Number(fact) > Number(plan);
      text = over
        ? `<span style="color:#d32f2f;font-weight:bold;">${fact} из ${plan}</span>`
        : `${fact} из ${plan}`;
    }

    res.send(renderHtml(text));
  } catch (err) {
    console.error('widget error:', err.message);
    res.send(renderHtml('Ошибка загрузки'));
  }
});

function clean(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

function renderHtml(text) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:2px 6px;
    font-family:Arial,sans-serif;font-size:13px;line-height:18px;color:#333;">${text}</body></html>`;
}

// ---------------------------------------------------------------------------

app.get('/', (req, res) => res.send('stage-days app is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
