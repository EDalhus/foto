--[[
	Foto – publiseringstjeneste for Lightroom Classic.

	Samlingssett i Lightroom blir mapper på nettstedet, samlinger blir album.
	Ved publisering eksporterer Lightroom ferdig redigerte JPEG-er som lastes opp.
	RAW-filene dine røres aldri.

	NB for utviklere: kall som leser katalogen kan «yielde». Pakk dem i LrTasks.pcall, aldri i vanlig pcall
	(vanlig pcall feiler i Lightroom når funksjonen inni yielder).
]]

local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrDate = import 'LrDate'
local LrFileUtils = import 'LrFileUtils'
local LrHttp = import 'LrHttp'
local LrPathUtils = import 'LrPathUtils'
local LrSystemInfo = import 'LrSystemInfo'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local Common = require 'FotoCommon'
local FotoAPI = require 'FotoAPI'
local JSON = require 'FotoJSON'
local Log = require 'FotoLog'

local provider = {}

-- Eksportinnstillinger --------------------------------------------------------

provider.supportsIncrementalPublish = 'only'
provider.exportPresetFields = {
	{ key = 'serverUrl', default = 'https://foto.dalhus.net' },
	{ key = 'apiToken', default = '' },
	{ key = 'serviceKey', default = '' },
	{ key = 'siteName', default = '' },
}
provider.hideSections = { 'exportLocation' }
provider.allowFileFormats = { 'JPEG' }
provider.allowColorSpaces = { 'sRGB' }
provider.hidePrintResolution = true
provider.canExportVideo = false

-- Publisering: navn og oppførsel i Lightroom ----------------------------------

provider.small_icon = 'icon.png'
provider.publish_fallbackNameBinding = 'siteName'
provider.titleForPublishedCollection = 'Album'
provider.titleForPublishedCollection_standalone = 'Album'
provider.titleForPublishedCollectionSet = 'Mappe'
provider.titleForPublishedCollectionSet_standalone = 'Mappe'
provider.titleForPublishedSmartCollection = 'Smart album'
provider.titleForPublishedSmartCollection_standalone = 'Smart album'
provider.titleForGoToPublishedCollection = 'Vis på nettstedet'
provider.titleForGoToPublishedPhoto = 'Vis på nettstedet'
provider.supportsCustomSortOrder = true

local DEFAULT_COLLECTION_NAME = 'Usortert'

function provider.getCollectionBehaviorInfo(publishSettings)
	return {
		defaultCollectionName = DEFAULT_COLLECTION_NAME,
		defaultCollectionCanBeDeleted = true,
		canAddCollection = true,
		maxCollectionSetDepth = 10,
	}
end

function provider.metadataThatTriggersRepublish(publishSettings)
	return {
		default = false,
		title = true,
		caption = true,
		keywords = true,
		dateCreated = true,
	}
end

-- Hjelpefunksjoner ------------------------------------------------------------

-- Felles med «Synkroniser med Foto» (FotoCommon.lua).
local serviceKeyOf = Common.serviceKeyOf
local isSet = Common.isSet
local nameOf = Common.nameOf
local remoteIdOf = Common.remoteIdOf
local settingsOf = Common.settingsOf
local visibilityOf = Common.visibilityOf
local parentEntry = Common.parentEntry
local ancestry = Common.ancestry

-- Innstillinger som ikke kom fram til nettstedet (f.eks. endret uten nett) lagres i Common.Pending
-- og sendes neste gang albumet (eller et album i mappa) publiseres.
local Pending = Common.Pending

-- Innstillingsdialogen for tjenesten -------------------------------------------

local function isConnected(propertyTable)
	return propertyTable.apiToken ~= nil and propertyTable.apiToken ~= ''
end

--- Viser hvem vi er koblet til som (eller at vi ikke er det).
local function refreshStatus(propertyTable)
	if not isConnected(propertyTable) then
		propertyTable.connectionStatus = 'Ikke tilkoblet. Trykk «Koble til Foto …» for å logge inn i nettleseren.'
		return
	end
	LrTasks.startAsyncTask(function()
		propertyTable.connectionStatus = 'Sjekker tilkoblingen …'
		local ok, result = LrTasks.pcall(function()
			return FotoAPI.new(propertyTable):me()
		end)
		if ok then
			local email = type(result) == 'table' and result.user and result.user.email or '?'
			propertyTable.connectionStatus = 'Tilkoblet som ' .. tostring(email) .. '.'
		else
			propertyTable.connectionStatus = FotoAPI.messageOf(result)
			Log.warn('Sjekk av tilkobling feilet:', FotoAPI.messageOf(result))
		end
	end)
end

function provider.startDialog(propertyTable)
	if not propertyTable.serviceKey or propertyTable.serviceKey == '' then
		propertyTable.serviceKey = FotoAPI.randomKey()
	end
	propertyTable.connecting = false
	propertyTable.connectAttempt = 0
	local function updateSiteName()
		propertyTable.siteName = FotoAPI.hostOf(propertyTable.serverUrl)
	end
	updateSiteName()
	propertyTable:addObserver('serverUrl', updateSiteName)
	refreshStatus(propertyTable)
end

function provider.endDialog(propertyTable)
	-- Stopp en eventuell venting på godkjenning når dialogen lukkes.
	propertyTable.connectAttempt = (propertyTable.connectAttempt or 0) + 1
	propertyTable.connecting = false
end

local function deviceName()
	local ok, name = pcall(function() return LrSystemInfo.computerName() end)
	if ok and type(name) == 'string' and name ~= '' then return name end
	return 'Mac'
end

--- «Koble til Foto …»: åpner nettleseren, venter på godkjenning og lagrer nøkkelen i innstillingene.
local function connect(propertyTable)
	if propertyTable.connecting then return end
	propertyTable.connectAttempt = (propertyTable.connectAttempt or 0) + 1
	local attempt = propertyTable.connectAttempt
	local serverUrl = propertyTable.serverUrl
	propertyTable.connecting = true
	propertyTable.connectionStatus = 'Starter …'
	local function current() return propertyTable.connectAttempt == attempt end
	LrTasks.startAsyncTask(function()
		local ok, err = LrTasks.pcall(function()
			local start = FotoAPI.connectStart(serverUrl, deviceName())
			Log.info('Koble til startet mot', FotoAPI.hostOf(serverUrl), 'kode', start.code)
			propertyTable.connectionStatus = 'Logg inn og trykk «Koble til» i nettleseren.\nKoden der skal være ' .. tostring(start.code) .. '.'
			LrHttp.openUrlInBrowser(start.url)
			local interval = math.max(1, tonumber(start.interval) or 2)
			local deadline = LrDate.currentTime() + (tonumber(start.expiresIn) or 600)
			local failures = 0
			while LrDate.currentTime() < deadline do
				LrTasks.sleep(interval)
				if not current() then return end
				local okPoll, res = LrTasks.pcall(function()
					return FotoAPI.connectPoll(serverUrl, start.pollSecret)
				end)
				if not current() then return end
				if not okPoll then
					-- Nettet hikker: prøv videre en stund før vi gir opp.
					failures = failures + 1
					Log.warn('Koble til: spørring feilet:', FotoAPI.messageOf(res))
					if failures >= 10 then error(res, 0) end
				elseif res.status == 'approved' and type(res.token) == 'string' then
					propertyTable.serverUrl = serverUrl
					propertyTable.apiToken = res.token
					propertyTable.connectionStatus = 'Tilkoblet som ' .. tostring(res.email or '?') .. '. Trykk «Lagre» for å beholde det.'
					Log.info('Koble til fullført mot', FotoAPI.hostOf(serverUrl))
					return
				elseif res.status == 'denied' then
					propertyTable.connectionStatus = 'Tilkoblingen ble avbrutt i nettleseren.'
					return
				elseif res.status == 'expired' then
					propertyTable.connectionStatus = 'Tiden gikk ut. Trykk «Koble til Foto …» på nytt.'
					return
				end
			end
			propertyTable.connectionStatus = 'Tiden gikk ut. Trykk «Koble til Foto …» på nytt.'
		end)
		if not current() then return end
		propertyTable.connecting = false
		if not ok then
			propertyTable.connectionStatus = FotoAPI.messageOf(err)
			Log.warn('Koble til feilet:', FotoAPI.messageOf(err))
		end
	end)
end

local function cancelConnect(propertyTable)
	propertyTable.connectAttempt = (propertyTable.connectAttempt or 0) + 1
	propertyTable.connecting = false
	refreshStatus(propertyTable)
end

--- «Koble fra»: trekker tilbake nøkkelen på nettstedet (om mulig) og glemmer den her.
local function disconnect(propertyTable)
	if not isConnected(propertyTable) then return end
	local settings = { serverUrl = propertyTable.serverUrl, apiToken = propertyTable.apiToken }
	propertyTable.apiToken = ''
	propertyTable.connectionStatus = 'Koblet fra. Trykk «Lagre» for å beholde det.'
	LrTasks.startAsyncTask(function()
		local ok, err = LrTasks.pcall(function()
			FotoAPI.new(settings):revoke()
		end)
		if ok then
			Log.info('Koblet fra', FotoAPI.hostOf(settings.serverUrl))
		else
			Log.warn('Koble fra: kunne ikke trekke tilbake nøkkelen på serveren:', FotoAPI.messageOf(err))
		end
	end)
end

function provider.sectionsForTopOfDialog(f, propertyTable)
	local bind = LrView.bind
	local share = LrView.share
	local notConnecting = bind { key = 'connecting', transform = function(v) return not v end }
	return {
		{
			title = 'Foto – tilkobling',
			synopsis = bind 'serverUrl',
			f:row {
				f:static_text { title = 'Serveradresse:', alignment = 'right', width = share 'fotoLabelWidth' },
				f:edit_field { value = bind 'serverUrl', width_in_chars = 34, immediate = true, enabled = notConnecting },
			},
			f:row {
				f:spacer { width = share 'fotoLabelWidth' },
				f:static_text { title = bind 'connectionStatus', fill_horizontal = 1, width_in_chars = 50, height_in_lines = 2 },
			},
			f:row {
				f:spacer { width = share 'fotoLabelWidth' },
				f:push_button {
					title = 'Koble til Foto …',
					enabled = notConnecting,
					action = function() connect(propertyTable) end,
				},
				f:push_button {
					title = 'Avbryt',
					enabled = bind 'connecting',
					action = function() cancelConnect(propertyTable) end,
				},
				f:push_button {
					title = 'Koble fra',
					enabled = bind { keys = { 'apiToken', 'connecting' }, operation = function(_, values)
						return values.apiToken ~= nil and values.apiToken ~= '' and not values.connecting
					end },
					action = function() disconnect(propertyTable) end,
				},
			},
			f:row {
				f:spacer { width = share 'fotoLabelWidth' },
				f:static_text {
					title = 'Tips: velg full størrelse og høy kvalitet under «Bildestørrelse» og «Filinnstillinger» – '
						.. 'det er denne fila som kan lastes ned i full oppløsning.',
					fill_horizontal = 1,
					width_in_chars = 50,
					height_in_lines = 2,
				},
			},
		},
	}
end

-- Innstillinger per album og mappe (vises når du lager eller redigerer dem) ----

local VISIBILITY_ITEMS = {
	{ title = 'Offentlig – alle kan se', value = 'public' },
	{ title = 'Privat – bare innloggede', value = 'private' },
}

function provider.viewForCollectionSettings(f, publishSettings, info)
	local bind = LrView.bind
	local share = LrView.share
	local cs = info.collectionSettings
	if not cs then return f:column {} end
	if cs.visibility == nil then cs.visibility = 'public' end
	if cs.allowDownload == nil then cs.allowDownload = false end
	return f:group_box {
		title = 'Foto',
		size = 'small',
		fill_horizontal = 1,
		bind_to_object = cs,
		f:column {
			fill_horizontal = 1,
			spacing = f:label_spacing(),
			f:row {
				f:static_text { title = 'Synlighet:', alignment = 'right', width = share 'fotoCollLabel' },
				f:popup_menu { value = bind 'visibility', items = VISIBILITY_ITEMS },
			},
			f:row {
				f:spacer { width = share 'fotoCollLabel' },
				f:checkbox { title = 'Tillat nedlasting av originaler', value = bind 'allowDownload' },
			},
		},
	}
end

function provider.viewForCollectionSetSettings(f, publishSettings, info)
	local bind = LrView.bind
	local share = LrView.share
	local cs = info.collectionSettings
	if not cs then return f:column {} end
	if cs.visibility == nil then cs.visibility = 'public' end
	return f:group_box {
		title = 'Foto',
		size = 'small',
		fill_horizontal = 1,
		bind_to_object = cs,
		f:column {
			fill_horizontal = 1,
			spacing = f:label_spacing(),
			f:row {
				f:static_text { title = 'Synlighet:', alignment = 'right', width = share 'fotoSetLabel' },
				f:popup_menu { value = bind 'visibility', items = VISIBILITY_ITEMS },
			},
			f:row {
				f:spacer { width = share 'fotoSetLabel' },
				f:static_text {
					title = 'En privat mappe skjuler alt som ligger i den, også album som er offentlige.',
					fill_horizontal = 1,
				},
			},
		},
	}
end

--- Sender endrede innstillinger til nettstedet. Feiler det, huskes endringen og sendes ved neste publisering.
local function pushSettings(publishSettings, info, kind)
	local obj = info.publishedCollection
	if not obj then return end -- helt nytt: innstillingene sendes med første publisering
	local serviceKey = serviceKeyOf(publishSettings, info.publishService)
	local lrId = obj.localIdentifier
	local cs = info.collectionSettings or {}
	local name = info.name or nameOf(obj)
	local ok, err = LrTasks.pcall(function()
		local payload = {
			serviceKey = serviceKey,
			kind = kind,
			lrId = lrId,
			name = name,
			parents = ancestry(obj),
			visibility = visibilityOf(cs),
			applySettings = true,
			remoteId = remoteIdOf(obj),
		}
		if kind == 'album' then payload.allowDownload = cs.allowDownload == true end
		FotoAPI.new(publishSettings):sync(payload)
	end)
	if ok then
		Pending.clear(serviceKey, kind, lrId)
		Log.info('Innstillinger lagret på nettstedet:', kind, name, visibilityOf(cs))
		return
	end
	Pending.mark(serviceKey, kind, lrId)
	local message = FotoAPI.messageOf(err)
	Log.warn('Innstillinger ikke sendt:', kind, name, message)
	LrDialogs.message(
		'Innstillingene er lagret i Lightroom, men ikke på nettstedet ennå',
		message .. '\n\nDe sendes automatisk neste gang du publiserer '
			.. (kind == 'album' and 'albumet.' or 'et album i mappa.'),
		'warning'
	)
end

function provider.updateCollectionSettings(publishSettings, info)
	pushSettings(publishSettings, info, 'album')
end

function provider.updateCollectionSetSettings(publishSettings, info)
	pushSettings(publishSettings, info, 'folder')
end

-- Selve publiseringen ---------------------------------------------------------

local function syncAlbum(api, exportContext, settings)
	local collection = exportContext.publishedCollection
	if not collection then error('Fant ikke albumet som publiseres.', 0) end
	local serviceKey = serviceKeyOf(settings, exportContext.publishService)
	local parents = ancestry(collection)

	-- Mappeinnstillinger som ikke kom fram tidligere.
	for i, p in ipairs(parents) do
		if Pending.has(serviceKey, 'folder', p.lrId) then
			local above = JSON.array({})
			for j = 1, i - 1 do above[j] = parents[j] end
			api:sync {
				serviceKey = serviceKey,
				kind = 'folder',
				lrId = p.lrId,
				name = p.name,
				parents = above,
				visibility = p.visibility,
				applySettings = true,
				remoteId = p.remoteId,
			}
			Pending.clear(serviceKey, 'folder', p.lrId)
			Log.info('Sendte ventende innstillinger for mappa', p.name, p.visibility)
		end
	end

	local cs = settingsOf(collection)
	local lrId = collection.localIdentifier
	local pending = Pending.has(serviceKey, 'album', lrId)
	local album = api:sync {
		serviceKey = serviceKey,
		kind = 'album',
		lrId = lrId,
		name = collection:getName(),
		parents = parents,
		visibility = visibilityOf(cs),
		allowDownload = cs.allowDownload == true,
		applySettings = pending,
		remoteId = remoteIdOf(collection),
	}
	if pending then
		Pending.clear(serviceKey, 'album', lrId)
		Log.info('Sendte ventende innstillinger for albumet', collection:getName(), visibilityOf(cs))
	end
	if type(album) ~= 'table' or not album.id then error('Serveren svarte uten album-ID.', 0) end
	return album
end

local function metadataOf(photo)
	local function get(key)
		local ok, v = LrTasks.pcall(function() return photo:getFormattedMetadata(key) end)
		if not ok then
			Log.warn('Kunne ikke lese', key, FotoAPI.messageOf(v))
			return ''
		end
		if v == nil then return '' end
		return tostring(v)
	end
	return {
		title = get('title'),
		caption = get('caption'),
		keywords = get('keywordTagsForExport'),
	}
end

function provider.processRenderedPhotos(functionContext, exportContext)
	local exportSession = exportContext.exportSession
	local settings = assert(exportContext.propertyTable)
	local nPhotos = exportSession:countRenditions()
	local progressScope = exportContext:configureProgress {
		title = nPhotos > 1 and string.format('Publiserer %d bilder til Foto', nPhotos) or 'Publiserer ett bilde til Foto',
	}

	local api = FotoAPI.new(settings)
	local album = syncAlbum(api, exportContext, settings)
	Log.info('Publiserer', nPhotos, 'bilde(r) til', tostring(album.path or album.id))
	exportSession:recordRemoteCollectionId(album.id)
	if album.url then exportSession:recordRemoteCollectionUrl(album.url) end

	local published, failed = 0, 0
	for i, rendition in exportContext:renditions { stopIfCanceled = true } do
		local base = (i - 1) / math.max(nPhotos, 1)
		progressScope:setPortionComplete(base)
		if not rendition.wasSkipped then
			local success, pathOrMessage = rendition:waitForRender()
			if progressScope:isCanceled() then
				if success then LrFileUtils.delete(pathOrMessage) end
				break
			end
			if success then
				local meta = metadataOf(rendition.photo)
				local function onProgress(fraction)
					local f = math.min(math.max(fraction, 0), 1)
					progressScope:setPortionComplete(base + (0.3 + 0.7 * f) / math.max(nPhotos, 1))
				end
				local ok, result = LrTasks.pcall(function()
					local existing = rendition.publishedPhotoId
					if existing and existing ~= '' then
						local replaced = api:replacePhoto(existing, pathOrMessage, meta, onProgress)
						if replaced then return replaced end
						Log.info('Bildet', existing, 'finnes ikke lenger på nettstedet – lastes opp som nytt')
					end
					return api:uploadPhoto(album.id, pathOrMessage, meta, onProgress)
				end)
				local fileName = LrPathUtils.leafName(pathOrMessage)
				LrFileUtils.delete(pathOrMessage)
				if ok and type(result) == 'table' and result.id then
					rendition:recordPublishedPhotoId(result.id)
					if result.url then rendition:recordPublishedPhotoUrl(result.url) end
					published = published + 1
				else
					local message = ok and 'Serveren svarte uten bilde-ID.' or FotoAPI.messageOf(result)
					Log.error('Publisering feilet for', fileName, '–', message)
					rendition:uploadFailed(message)
					failed = failed + 1
				end
			else
				Log.error('Lightroom klarte ikke å eksportere et bilde:', tostring(pathOrMessage))
				rendition:uploadFailed(pathOrMessage)
				failed = failed + 1
			end
		end
	end
	progressScope:done()
	Log.info('Ferdig med', tostring(album.path or album.id), '–', published, 'publisert,', failed, 'feilet')
end

-- Endringer i Lightroom som skal speiles på nettstedet -------------------------

function provider.deletePhotosFromPublishedCollection(publishSettings, arrayOfPhotoIds, deletedCallback, localCollectionId)
	if not arrayOfPhotoIds or #arrayOfPhotoIds == 0 then return end
	local api = FotoAPI.new(publishSettings)
	local BATCH = 500
	for start = 1, #arrayOfPhotoIds, BATCH do
		local batch = JSON.array({})
		for i = start, math.min(start + BATCH - 1, #arrayOfPhotoIds) do batch[#batch + 1] = arrayOfPhotoIds[i] end
		api:deletePhotos(batch)
		for _, id in ipairs(batch) do deletedCallback(id) end
	end
	Log.info('Slettet', #arrayOfPhotoIds, 'bilde(r) fra nettstedet')
end

function provider.renamePublishedCollection(publishSettings, info)
	local obj = info.publishedCollection
	if not obj then return end
	local kind = isSet(obj) and 'folder' or 'album'
	local result = FotoAPI.new(publishSettings):sync {
		serviceKey = serviceKeyOf(publishSettings, info.publishService),
		kind = kind,
		lrId = obj.localIdentifier,
		name = info.name,
		parents = ancestry(obj),
		visibility = visibilityOf(settingsOf(obj)),
		onlyIfExists = true,
		remoteId = remoteIdOf(obj) or (info.remoteId and tostring(info.remoteId)) or nil,
	}
	Log.info('Nytt navn:', kind, tostring(info.name), (type(result) == 'table' and result.id) and '' or '(ikke publisert ennå)')
end

--- Ny plassering etter flytting. Lightroom gir oss foreldrene som en liste uten avtalt rekkefølge.
--- Den nærmeste er den som ikke er forelder til noen av de andre; stien bygges derfra.
local function newParents(info)
	local list = info.parents or {}
	if #list == 0 then return JSON.array({}) end
	local sets = {}
	local ok, err = LrTasks.pcall(function()
		local function walk(container)
			for _, s in ipairs(container:getChildCollectionSets() or {}) do
				sets[s.localIdentifier] = s
				walk(s)
			end
		end
		if info.publishService then walk(info.publishService) end
	end)
	if not ok then Log.warn('Kunne ikke lese mappene i tjenesten:', FotoAPI.messageOf(err)) end

	local isParentOfAnother = {}
	for _, p in ipairs(list) do
		local s = sets[p.localCollectionId]
		local parent = s and s:getParent()
		if parent then isParentOfAnother[parent.localIdentifier] = true end
	end
	local nearest
	for _, p in ipairs(list) do
		if sets[p.localCollectionId] and not isParentOfAnother[p.localCollectionId] then
			nearest = sets[p.localCollectionId]
		end
	end
	if nearest then
		local chain = ancestry(nearest)
		chain[#chain + 1] = parentEntry(nearest)
		return chain
	end
	-- Reserve: lista slik den kom (antatt fra toppnivå og ned). Ukjent synlighet → privat, for sikkerhets skyld.
	local out = JSON.array({})
	for _, p in ipairs(list) do
		out[#out + 1] = { lrId = p.localCollectionId, name = p.name, visibility = 'private' }
	end
	return out
end

function provider.reparentPublishedCollection(publishSettings, info)
	local obj = info.publishedCollection
	if not obj then return end
	local kind = isSet(obj) and 'folder' or 'album'
	local result = FotoAPI.new(publishSettings):sync {
		serviceKey = serviceKeyOf(publishSettings, info.publishService),
		kind = kind,
		lrId = obj.localIdentifier,
		name = info.name or nameOf(obj),
		parents = newParents(info),
		visibility = visibilityOf(settingsOf(obj)),
		onlyIfExists = true,
		remoteId = remoteIdOf(obj) or (info.remoteId and tostring(info.remoteId)) or nil,
	}
	Log.info('Flyttet:', kind, tostring(info.name or nameOf(obj)), (type(result) == 'table' and result.path) or '(ikke publisert ennå)')
end

function provider.deletePublishedCollection(publishSettings, info)
	local obj = info.publishedCollection
	local payload = { serviceKey = serviceKeyOf(publishSettings, info.publishService), id = info.remoteId }
	if obj then
		payload.kind = isSet(obj) and 'folder' or 'album'
		payload.lrId = obj.localIdentifier
	end
	if not payload.lrId and not payload.id then return end
	local result = FotoAPI.new(publishSettings):deleteCollection(payload)
	Log.info('Slettet fra nettstedet:', payload.kind or '', tostring(info.name),
		(type(result) == 'table' and result.deleted) and '' or '(fantes ikke der)')
end

function provider.imposeSortOrderOnPublishedCollection(publishSettings, info, remoteIdSequence)
	-- Lightroom kaller feltet remoteCollectionId her (ikke remoteId som i de andre kallene).
	local albumId = info.remoteCollectionId or info.remoteId
	if not albumId or albumId == '' or not remoteIdSequence or #remoteIdSequence == 0 then return end
	FotoAPI.new(publishSettings):setOrder(albumId, remoteIdSequence)
	Log.info('Rekkefølge satt for', tostring(info.name or albumId), '(' .. #remoteIdSequence .. ' bilder)')
end

--- Lightroom lager en tom standardsamling i nye tjenester. Den fjernes, så du starter med en ren tjeneste.
function provider.didCreateNewPublishService(publishSettings, info)
	local service = info and info.publishService
	if not service then return end
	local ok, err = LrTasks.pcall(function()
		local empty = {}
		for _, c in ipairs(service:getChildCollections() or {}) do
			local summary = c:getCollectionInfoSummary()
			local isDefault = type(summary) == 'table' and summary.isDefaultCollection
			if (isDefault or c:getName() == DEFAULT_COLLECTION_NAME) and #(c:getPhotos() or {}) == 0 then
				empty[#empty + 1] = c
			end
		end
		if #empty == 0 then return end
		LrApplication.activeCatalog():withWriteAccessDo('Foto: fjern tom standardsamling', function()
			for _, c in ipairs(empty) do c:delete() end
		end, { timeout = 10 })
	end)
	if not ok then Log.warn('Kunne ikke fjerne standardsamlingen:', FotoAPI.messageOf(err)) end
	Log.info('Ny Foto-tjeneste opprettet for', FotoAPI.hostOf(publishSettings and publishSettings.serverUrl))
end

return provider
