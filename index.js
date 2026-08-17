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

  const restUrl = SERVER_ENDPOINT;
  const handlerUrl = `https://${req.get('host')}/kolvo-dney-widget`;

  const log = [];

  // 1. Регистрируем тип поля (если уже есть — просто пропускаем)
  try {
    await callBitrix(restUrl, AUTH_ID, 'userfieldtype.add', {
      USER_TYPE_ID,
      HANDLER: handlerUrl,
      TITLE: 'Дней (просмотр)',
      DESCRIPTION: 'Только отображение значения, без редактирования',
    });
    log.push('Тип поля зарегистрирован.');
  } catch (e) {
    log.push(`Тип поля: ${e.message} (возможно, уже был зарегистрирован раньше — это нормально).`);
  }

  // 2. Создаём поле в Лидах
  try {
    await callBitrix(restUrl, AUTH_ID, 'crm.lead.userfield.add', {
      fields: {
        FIELD_NAME: 'KOLVO_DNEY_VIEW',
        USER_TYPE_ID,
        LABEL: 'Дней (просмотр)',
        EDIT_FORM_LABEL: { ru: 'Дней (просмотр)' },
      },
    });
    log.push('Поле в Лидах создано.');
  } catch (e) {
    log.push(`Поле в Лидах: ${e.message} (возможно, уже создано раньше).`);
  }

  // 3. Создаём поле в Сделках
  try {
    await callBitrix(restUrl, AUTH_ID, 'crm.deal.userfield.add', {
      fields: {
        FIELD_NAME: 'KOLVO_DNEY_VIEW',
        USER_TYPE_ID,
        LABEL: 'Дней (просмотр)',
        EDIT_FORM_LABEL: { ru: 'Дней (просмотр)' },
      },
    });
    log.push('Поле в Сделках создано.');
  } catch (e) {
    log.push(`Поле в Сделках: ${e.message} (возможно, уже создано раньше).`);
  }

  console.log('Установка kolvo-dney завершена:', log.join(' | '));
  res.send(installFinishHtml(log.join('<br>')));
});

// Bitrix24 иногда открывает /install через GET при повторном заходе
app.get('/install', (req, res) => {
  res.send(installFinishHtml('Приложение уже установлено.'));
});

async function callBitrix(restUrl, authId, method, fields) {
  const response = await axios.post(`${restUrl}${method}`, fields, {
    params: { auth: authId },
  });
  if (response.data.error) {
    throw new Error(response.data.error_description || response.data.error);
  }
  return response.data.result;
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
  return `<!DOCTYPE html><html><body style="margin:0;padding:6px 10px;
    font-family:Arial,sans-serif;font-size:13px;color:#333;">${text}</body></html>`;
}

// ---------------------------------------------------------------------------

app.get('/', (req, res) => res.send('kolvo-dney app is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
