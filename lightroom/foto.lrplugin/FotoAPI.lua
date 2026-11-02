--[[
	HTTP-kall mot Foto-serveren. Alle kall bruker API-nøkkelen som «Bearer»-token.
	Feil kastes som Lua-feil med en norsk melding som Lightroom viser til brukeren.

	Forbigående feil (serveren starter på nytt, nettet hikker) prøves på nytt et par ganger.
	Opplasting av nye bilder prøves bare på nytt når vi vet at serveren ikke fikk forespørselen,
	så et bilde aldri havner to ganger i albumet.
]]

local LrHttp = import 'LrHttp'
local LrPathUtils = import 'LrPathUtils'
local LrMD5 = import 'LrMD5'
local LrDate = import 'LrDate'
local LrTasks = import 'LrTasks'

local JSON = require 'FotoJSON'
local Log = require 'FotoLog'

local FotoAPI = {}
FotoAPI.__index = FotoAPI

--- Holdes lik VERSION i Info.lua. Sendes til serveren i X-Foto-Plugin.
FotoAPI.VERSION = '0.3.0'

local function trim(s)
	return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', ''))
end

--- Normaliser serveradressen: https:// foran, ingen skråstrek bak.
function FotoAPI.normalizeUrl(url)
	local u = trim(url):gsub('/+$', '')
	if u ~= '' and not u:match('^https?://') then u = 'https://' .. u end
	return u
end

--- Vertsnavnet i serveradressen, f.eks. «foto.dalhus.net».
function FotoAPI.hostOf(url)
	return FotoAPI.normalizeUrl(url):match('^https?://([^/:]+)') or ''
end

--- Tilfeldig nøkkel som skiller denne publiseringstjenesten fra andre (lagres i innstillingene).
function FotoAPI.randomKey()
	math.randomseed(math.floor((LrDate.currentTime() % 1) * 1e6) + math.floor(LrDate.currentTime()))
	local seed = tostring(LrDate.currentTime()) .. tostring(math.random()) .. tostring({})
	return string.sub(LrMD5.digest(seed), 1, 16)
end

--- Gjør en feil (fra pcall) om til en lesbar melding uten Lua-filnavn og linjenummer foran.
function FotoAPI.messageOf(err)
	if type(err) == 'table' then err = err.message or err.error or tostring(err) end
	local s = tostring(err or 'Ukjent feil')
	s = s:gsub('^%[string "[^"]*"%]:%d+: ', ''):gsub('^[%w_%.%-/ ]+%.lua:%d+: ', '')
	return s
end

function FotoAPI.new(settings)
	local base = FotoAPI.normalizeUrl(settings.serverUrl)
	if base == '' then
		error('Serveradressen mangler. Høyreklikk Foto under «Publiser tjenester» og velg «Rediger innstillinger…».', 0)
	end
	local token = trim(settings.apiToken)
	if token == '' then
		error('Lightroom er ikke koblet til Foto. Høyreklikk Foto under «Publiser tjenester», velg «Rediger innstillinger …» og trykk «Koble til Foto …».', 0)
	end
	return setmetatable({ base = base, token = token }, FotoAPI)
end

function FotoAPI:headers(extra)
	local h = {
		{ field = 'Authorization', value = 'Bearer ' .. self.token },
		{ field = 'Accept', value = 'application/json' },
		{ field = 'X-Foto-Plugin', value = FotoAPI.VERSION },
	}
	for _, x in ipairs(extra or {}) do h[#h + 1] = x end
	return h
end

-- Nye forsøk ------------------------------------------------------------------

local NETWORK_MESSAGES = {
	timedOut = 'serveren svarte ikke i tide',
	cannotFindHost = 'fant ikke serveren – sjekk adressen og nettforbindelsen',
	cannotConnectToHost = 'kom ikke i kontakt med serveren',
	networkConnectionLost = 'nettforbindelsen ble brutt',
	resourceUnavailable = 'serveren er ikke tilgjengelig',
	badServerResponse = 'serveren svarte med noe uventet',
	securityError = 'den sikre tilkoblingen (HTTPS) feilet',
	serverCertificateHasBadDate = 'sertifikatet til serveren er utløpt',
	serverCertificateHasUnknownRoot = 'sertifikatet til serveren er ukjent',
	badURL = 'serveradressen er ugyldig',
}

-- Forespørselen kom aldri fram til serveren: trygt å prøve igjen.
local NOT_SENT = { cannotFindHost = true, cannotConnectToHost = true }
-- Vi vet ikke om serveren rakk å behandle forespørselen: prøv igjen bare når kallet tåler å gjentas.
local MAYBE_SENT = { timedOut = true, networkConnectionLost = true, resourceUnavailable = true, badServerResponse = true }
-- 502/503: appen fikk ikke forespørselen (f.eks. mens den starter på nytt). 504: kanskje behandlet.
local STATUS_NOT_HANDLED = { [502] = true, [503] = true }
local STATUS_MAYBE_HANDLED = { [504] = true }

local DEFAULT_DELAYS = { 2, 5, 10 }

--- Kjører send() med nye forsøk ved forbigående feil. Returnerer (body, headers) fra siste forsøk.
--- opts.idempotent: kallet kan trygt gjentas. opts.delays: ventetider i sekunder ({} = ingen nye forsøk).
function FotoAPI:request(label, opts, send)
	local delays = opts.delays or DEFAULT_DELAYS
	local attempt = 0
	while true do
		attempt = attempt + 1
		local started = LrDate.currentTime()
		local body, headers = send()
		local ms = math.floor((LrDate.currentTime() - started) * 1000 + 0.5)
		local retry = false
		local netError = body == nil and type(headers) == 'table' and headers.error
		if netError then
			local code = tostring(netError.errorCode or '')
			Log.warn(label, 'nettverksfeil:', code, tostring(netError.name or ''), ms .. ' ms', 'forsøk ' .. attempt)
			retry = NOT_SENT[code] or (opts.idempotent and MAYBE_SENT[code]) or false
		else
			local status = type(headers) == 'table' and tonumber(headers.status) or 0
			if status >= 400 then
				Log.warn(label, status, ms .. ' ms', 'forsøk ' .. attempt)
			else
				Log.info(label, status, ms .. ' ms')
			end
			retry = STATUS_NOT_HANDLED[status] or (opts.idempotent and STATUS_MAYBE_HANDLED[status]) or false
		end
		if not retry or attempt > #delays then return body, headers end
		LrTasks.sleep(delays[attempt])
	end
end

--- Tolker svaret. Returnerer (data, status). Kaster feil hvis serveren ikke kunne nås.
local function parse(body, headers)
	if body == nil and type(headers) == 'table' and headers.error then
		local e = headers.error
		local reason = NETWORK_MESSAGES[e.errorCode] or tostring(e.name or e.errorCode or 'ukjent feil')
		error('Fikk ikke kontakt med Foto-serveren: ' .. reason .. '.', 0)
	end
	local status = type(headers) == 'table' and tonumber(headers.status) or 0
	local data
	if body and body ~= '' then
		local ok, decoded = pcall(JSON.decode, body)
		if ok then data = decoded end
	end
	return data, status
end

--- Kaster en lesbar feil hvis status ikke er 2xx.
local function ensure(data, status, what)
	if status >= 200 and status < 300 then return data end
	local reason = (type(data) == 'table' and data.error) or ('serveren svarte ' .. tostring(status))
	if status == 401 then reason = 'Lightroom er ikke lenger koblet til nettstedet. Høyreklikk Foto under «Publiser tjenester», velg «Rediger innstillinger …» og trykk «Koble til Foto …» på nytt'
	elseif status == 413 then reason = 'fila er for stor for serveren'
	elseif status == 502 or status == 503 then reason = 'serveren er midlertidig utilgjengelig – prøv igjen om litt'
	end
	error(what .. ': ' .. tostring(reason), 0)
end

function FotoAPI:get(path, opts)
	return parse(self:request('GET ' .. path, opts or { idempotent = true }, function()
		return LrHttp.get(self.base .. path, self:headers(), 30)
	end))
end

function FotoAPI:postJson(path, payload, opts)
	local body = JSON.encode(payload or {})
	return parse(self:request('POST ' .. path, opts or { idempotent = true }, function()
		return LrHttp.post(
			self.base .. path,
			body,
			self:headers({ { field = 'Content-Type', value = 'application/json' } }),
			'POST',
			60
		)
	end))
end

--- Laster opp en fil. onProgress(0..1) kalles underveis hvis Lightroom støtter det.
function FotoAPI:postFile(path, filePath, fields, opts, onProgress)
	local content = {
		{
			name = 'file',
			fileName = LrPathUtils.leafName(filePath),
			filePath = filePath,
			contentType = 'image/jpeg',
		},
	}
	local names = {}
	for k in pairs(fields or {}) do names[#names + 1] = k end
	table.sort(names)
	for _, k in ipairs(names) do
		content[#content + 1] = { name = k, value = tostring(fields[k] or '') }
	end
	local callback
	if onProgress then
		callback = function(fraction) pcall(onProgress, tonumber(fraction) or 0) end
	end
	return parse(self:request('POST ' .. path, opts, function()
		return LrHttp.postMultipart(self.base .. path, content, self:headers(), 600, callback)
	end))
end

-- Koble til (uten nøkkel) ---------------------------------------------------------

--- Kall uten API-nøkkel, brukt mens vi kobler til. Returnerer (data, status).
local function connectCall(base, path, payload)
	local body = JSON.encode(payload)
	local headers = {
		{ field = 'Accept', value = 'application/json' },
		{ field = 'Content-Type', value = 'application/json' },
		{ field = 'X-Foto-Plugin', value = FotoAPI.VERSION },
	}
	local started = LrDate.currentTime()
	local res, h = LrHttp.post(base .. path, body, headers, 'POST', 30)
	local data, status = parse(res, h)
	if status >= 400 then
		Log.warn('POST ' .. path, status, math.floor((LrDate.currentTime() - started) * 1000 + 0.5) .. ' ms')
	end
	return data, status
end

--- Starter tilkoblingen. Returnerer { pollSecret, code, url, interval, expiresIn }.
function FotoAPI.connectStart(serverUrl, device)
	local base = FotoAPI.normalizeUrl(serverUrl)
	if base == '' then error('Fyll inn serveradressen først.', 0) end
	local data, status = connectCall(base, '/api/v1/connect/start', { device = device })
	if status == 404 then error('Serveren støtter ikke «Koble til» ennå. Sjekk adressen, eller oppdater Foto-serveren.', 0) end
	data = ensure(data, status, 'Kunne ikke starte tilkoblingen')
	if type(data) ~= 'table' or type(data.pollSecret) ~= 'string' or type(data.url) ~= 'string' then
		error('Kunne ikke starte tilkoblingen: uventet svar fra serveren.', 0)
	end
	return data
end

--- Spør om tilkoblingen er godkjent. Returnerer { status = 'pending' | 'approved' | 'denied' | 'expired', token?, email? }.
function FotoAPI.connectPoll(serverUrl, pollSecret)
	local data, status = connectCall(FotoAPI.normalizeUrl(serverUrl), '/api/v1/connect/poll', { pollSecret = pollSecret })
	return ensure(data, status, 'Tilkoblingen feilet')
end

-- Endepunkter -----------------------------------------------------------------

--- Test tilkobling. Ingen nye forsøk – svaret skal komme med en gang.
function FotoAPI:me()
	local data, status = self:get('/api/v1/me', { idempotent = true, delays = {} })
	return ensure(data, status, 'Tilkoblingen feilet')
end

--- «Koble fra»: sletter nøkkelen vi bruker på nettstedet. Ingen nye forsøk.
function FotoAPI:revoke()
	local data, status = self:postJson('/api/v1/connect/revoke', {}, { idempotent = true, delays = {} })
	if status == 401 then return true end -- allerede trukket tilbake
	return ensure(data, status, 'Kunne ikke koble fra')
end

--- Finn/opprett mappe eller album.
--- payload: { serviceKey, kind, lrId, name, parents = { { lrId, name, visibility } }, visibility?, allowDownload?, applySettings? }
function FotoAPI:sync(payload)
	local data, status = self:postJson('/api/v1/lr/sync', payload)
	return ensure(data, status, 'Kunne ikke opprette/oppdatere «' .. tostring(payload.name) .. '» på nettstedet')
end

function FotoAPI:deleteCollection(payload)
	local data, status = self:postJson('/api/v1/lr/delete-collection', payload)
	return ensure(data, status, 'Kunne ikke slette på nettstedet')
end

function FotoAPI:uploadPhoto(albumId, filePath, meta, onProgress)
	local data, status = self:postFile('/api/v1/albums/' .. albumId .. '/photos', filePath, meta, { idempotent = false }, onProgress)
	return ensure(data, status, 'Opplastingen feilet')
end

--- Erstatter et publisert bilde. Returnerer nil hvis bildet ikke finnes på serveren lenger.
function FotoAPI:replacePhoto(photoId, filePath, meta, onProgress)
	local data, status = self:postFile('/api/v1/photos/' .. photoId .. '/replace', filePath, meta, { idempotent = true }, onProgress)
	if status == 404 then return nil end
	return ensure(data, status, 'Ny versjon feilet')
end

function FotoAPI:deletePhotos(ids)
	local data, status = self:postJson('/api/v1/lr/delete-photos', { ids = JSON.array(ids) })
	return ensure(data, status, 'Kunne ikke slette bilder på nettstedet')
end

function FotoAPI:setOrder(albumId, photoIds)
	local data, status = self:postJson('/api/v1/albums/' .. albumId .. '/order', { photoIds = JSON.array(photoIds) })
	return ensure(data, status, 'Kunne ikke sette rekkefølgen på nettstedet')
end

return FotoAPI
