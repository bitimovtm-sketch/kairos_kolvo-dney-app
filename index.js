// ============================================================================
// Приложение "Дней (просмотр)" для Bitrix24 (kairos-dv.bitrix24.ru)
//
// Что делает:
// 1. При установке приложения (/install) автоматически:
//    - регистрирует новый тип поля в Bitrix24 (userfieldtype.add)
//    - создаёт поле в Лидах, которое показывает значение UF_CRM_KOLVO_DNEY
//    - создаёт поле в Сделках, которое показывает значение UF_CRM_KOLVO_DNEY_SDELKA
// 2. При открытии карточки лида/сделки (/kolvo-dney-widget) отдаёт
//    простой текст со значением поля — без формы ввода, значит без
//    возможности редактирования.
// ============================================================================

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Входящий вебхук для ЧТЕНИЯ значений (создаётся один раз в Bitrix24:
// Разработчикам -> Другое -> Входящий вебхук, права crm).
// Указывается в Railway -> Variables -> KOLVO_DNEY_WEBHOOK
// Пример: https://kairos-dv.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
const READ_WEBHOOK = process.env.KOLVO_DNEY_WEBHOOK;

// Код нового типа поля (фиксированный, менять не нужно)
const USER_TYPE_ID = 'kolvo_dney_view';

const SOURCE_FIELD = {
  CRM_LEAD: 'UF_CRM_KOLVO_DNEY',
  CRM_DEAL: 'UF_CRM_KOLVO_DNEY_SDELKA',
};

const GET_METHOD = {
  CRM_LEAD: 'crm.lead.get',
  CRM_DEAL: 'crm.deal.get',
};

// ---------------------------------------------------------------------------
// Установка приложения
// ---------------------------------------------------------------------------

app.post('/install', async (req, res) => {
  // Логируем сырые данные — пригодится, если формат снова не совпадёт
  console.log('INSTALL request body:', JSON.stringify(req.body));

  // Bitrix24 в этом случае присылает SERVER_ENDPOINT (адрес для REST-запросов)
  // и AUTH_ID (токен доступа) — портал определяется по токену, отдельный DOMAIN не нужен.
  const SERVER_ENDPOINT = req.body.SERVER_ENDPOINT || req.body?.auth?.server_endpoint;
  const AUTH_ID = req.body.AUTH_ID || req.body?.auth?.access_token;

  if (!SERVER_ENDPOINT || !AUTH_ID) {
    console.log('INSTALL: не хватает SERVER_ENDPOINT/AUTH_ID в присланных данных');
    return res.send(installFinishHtml('Не хватает данных установки. Обновите страницу и попробуйте снова.'));
  }

  const referer = req.headers.referer || req.headers.referrer || '';
  const refererMatch = referer.match(/^https?:\/\/([^/]+)/);
  const PORTAL_DOMAIN = refererMatch ? refererMatch[1] : null;

  const restUrl = PORTAL_DOMAIN ? `https://${PORTAL_DOMAIN}/rest/` : SERVER_ENDPOINT;
  const handlerUrl = `https://${req.get('host')}/kolvo-dney-widget`;

  console.log('INSTALL using restUrl:', restUrl);

  const log = [];
  const FIELD_LABEL = 'Количество дней в работе';

  // 1. Регистрируем тип поля. Если он уже есть — обновляем название и высоту.
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
      log.push('Тип поля обновлён (название и высота).');
    } catch (e2) {
      log.push(`Тип поля: ${e2.message}`);
    }
  }

  // 2. Узнаём НАСТОЯЩИЙ код типа — Bitrix24 превращает его в rest_<ID приложения>_<наш код>
  let realTypeId = null;
  try {
    const types = await callBitrix(restUrl, AUTH_ID, 'userfieldtype.list', {});
    console.log('userfieldtype.list ответ:', JSON.stringify(types));
    const list = Array.isArray(types) ? types : Object.values(types || {});
    const found = list.find((t) => String(t.USER_TYPE_ID || '').endsWith(USER_TYPE_ID));
    realTypeId = found ? found.USER_TYPE_ID : null;
    log.push(realTypeId
      ? `Код типа определён: ${realTypeId}`
      : `Тип не найден. Список типов: ${JSON.stringify(list)}`);
  } catch (e) {
    log.push(`Список типов: ${e.message}`);
  }

  if (!realTypeId) {
    // Запасной способ: собираем код сами из ID приложения
    try {
      const info = await callBitrix(restUrl, AUTH_ID, 'app.info', {});
      console.log('app.info ответ:', JSON.stringify(info));
      if (info && info.ID) {
        realTypeId = `rest_${info.ID}_${USER_TYPE_ID}`;
        log.push(`Код типа собран вручную: ${realTypeId}`);
      }
    } catch (e) {
      log.push(`app.info: ${e.message}`);
    }
  }

  if (!realTypeId) {
    console.log('Установка kolvo-dney НЕ завершена:', log.join(' | '));
    return res.send(installFinishHtml(log.join('<br>')));
  }

  // 3-4. Создаём поля, а если они уже есть — переименовываем
  await ensureField(restUrl, AUTH_ID, 'lead', realTypeId, FIELD_LABEL, log, 'Лидах');
  await ensureField(restUrl, AUTH_ID, 'deal', realTypeId, FIELD_LABEL, log, 'Сделках');

  console.log('Установка kolvo-dney завершена:', log.join(' | '));
  res.send(installFinishHtml(log.join('<br>')));
});

// Создаёт поле, если его нет; если есть — обновляет название
async function ensureField(restUrl, authId, entity, typeId, label, log, humanName) {
  const fieldName = 'KOLVO_DNEY_VIEW';
  const fullName = `UF_CRM_${fieldName}`;

  try {
    const existing = await callBitrix(restUrl, authId, `crm.${entity}.userfield.list`, {
      filter: { FIELD_NAME: fullName },
    });
    const list = Array.isArray(existing) ? existing : Object.values(existing || {});

    if (list.length > 0) {
      await callBitrix(restUrl, authId, `crm.${entity}.userfield.update`, {
        id: list[0].ID,
        fields: {
          LABEL: label,
          EDIT_FORM_LABEL: { ru: label },
          LIST_COLUMN_LABEL: { ru: label },
        },
      });
      log.push(`Поле в ${humanName} переименовано.`);
      return;
    }

    await callBitrix(restUrl, authId, `crm.${entity}.userfield.add`, {
      fields: {
        FIELD_NAME: fieldName,
        USER_TYPE_ID: typeId,
        LABEL: label,
        EDIT_FORM_LABEL: { ru: label },
        LIST_COLUMN_LABEL: { ru: label },
      },
    });
    log.push(`Поле в ${humanName} создано.`);
  } catch (e) {
    log.push(`Поле в ${humanName}: ${e.message}`);
  }
}

// Bitrix24 иногда открывает /install через GET при повторном заходе
app.get('/install', (req, res) => {
  res.send(installFinishHtml('Приложение уже установлено.'));
});

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
// Отображение поля на карточке (read-only)
// ---------------------------------------------------------------------------

app.all('/kolvo-dney-widget', async (req, res) => {
  try {
    const raw = req.body && req.body.PLACEMENT_OPTIONS
      ? JSON.parse(req.body.PLACEMENT_OPTIONS)
      : { ...req.query, ...req.body };

    const entityId = raw.ENTITY_ID;
    const itemId = raw.ENTITY_VALUE_ID;

    const method = GET_METHOD[entityId];
    const field = SOURCE_FIELD[entityId];

    if (!method || !itemId || !READ_WEBHOOK) {
      return res.send(renderHtml('—'));
    }

    const response = await axios.get(`${READ_WEBHOOK}${method}`, {
      params: { id: itemId },
    });

    const value = response.data?.result?.[field];
    res.send(renderHtml(value !== undefined && value !== null && value !== '' ? value : '—'));
  } catch (err) {
    console.error('kolvo-dney-widget error:', err.message);
    res.send(renderHtml('Ошибка загрузки'));
  }
});

function renderHtml(text) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:2px 6px;
    font-family:Arial,sans-serif;font-size:13px;line-height:18px;color:#333;">${text}</body></html>`;
}

// ---------------------------------------------------------------------------

app.get('/', (req, res) => res.send('kolvo-dney app is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
