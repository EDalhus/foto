--[[
	Fil (eller Bibliotek) → Ekstra pluginmoduler → Kopier album fra SmugMug …

	Lager de samme mappene og albumene under Foto-tjenesten som i en annen publiseringstjeneste
	(typisk SmugMug), med de samme bildene. Bare Lightroom-katalogen endres: ingenting lastes opp før
	du trykker «Publiser», og den andre tjenesten røres ikke.

	Kan kjøres flere ganger. Det som finnes fra før under Foto, får bare nye bilder lagt til –
	innstillingene (synlighet, nedlasting) endres ikke.
]]

local LrApplication = import 'LrApplication'
local LrBinding = import 'LrBinding'
local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local Log = require 'FotoLog'

local SMUGMUG_PLUGIN = 'com.smugmug.lightroom.publish'

-- Synlighet fra SmugMug -------------------------------------------------------------
-- SmugMug lagrer «Privacy»/«EffectivePrivacy» = Public, Unlisted eller Private et sted i innstillingene.

local function findString(t, key, depth, seen)
	if type(t) ~= 'table' or depth > 4 or seen[t] then return nil end
	seen[t] = true
	local v = t[key]
	if type(v) == 'string' and v ~= '' then return v end
	for _, child in pairs(t) do
		local found = findString(child, key, depth + 1, seen)
		if found then return found end
	end
	return nil
end

local function privacyIn(settings)
	if type(settings) ~= 'table' then return nil end
	local ok, value = pcall(function()
		return findString(settings, 'EffectivePrivacy', 0, {}) or findString(settings, 'Privacy', 0, {})
	end)
	if ok and type(value) == 'string' then return value:lower() end
	return nil
end

local function settingsOf(obj, isSet)
	local ok, summary = LrTasks.pcall(function()
		if isSet then return obj:getCollectionSetInfoSummary() end
		return obj:getCollectionInfoSummary()
	end)
	if ok and type(summary) == 'table' then return summary.collectionSettings end
	return nil
end

-- Lesing ----------------------------------------------------------------------------

local function readSource(container)
	local node = { sets = {}, collections = {} }
	for _, set in ipairs(container:getChildCollectionSets() or {}) do
		local child = readSource(set)
		child.name = set:getName()
		child.privacy = privacyIn(settingsOf(set, true))
		node.sets[#node.sets + 1] = child
	end
	for _, c in ipairs(container:getChildCollections() or {}) do
		local item = { name = c:getName(), smart = c:isSmartCollection() == true }
		item.privacy = privacyIn(settingsOf(c, false))
		if item.smart then
			local ok, desc = LrTasks.pcall(function() return c:getSearchDescription() end)
			if ok and type(desc) == 'table' then item.search = desc end
		end
		item.photos = c:getPhotos() or {}
		node.collections[#node.collections + 1] = item
	end
	return node
end

local function readTarget(container)
	local node = { sets = {}, collections = {} }
	for _, set in ipairs(container:getChildCollectionSets() or {}) do
		local child = readTarget(set)
		child.obj = set
		node.sets[set:getName()] = child
	end
	for _, c in ipairs(container:getChildCollections() or {}) do
		node.collections[c:getName()] = { obj = c, smart = c:isSmartCollection() == true }
	end
	return node
end

local function countAlbums(node)
	local n = #node.collections
	for _, s in ipairs(node.sets) do n = n + countAlbums(s) end
	return n
end

local function countPhotos(node, seen)
	local n = 0
	for _, c in ipairs(node.collections) do
		for _, p in ipairs(c.photos) do
			local id = p.localIdentifier or p
			if not seen[id] then
				seen[id] = true
				n = n + 1
			end
		end
	end
	for _, s in ipairs(node.sets) do n = n + countPhotos(s, seen) end
	return n
end

-- Skriving --------------------------------------------------------------------------

local function visibilityFor(item, mode, stats)
	if mode == 'public' or mode == 'private' then return mode end
	if item.privacy == 'public' then return 'public' end
	if item.privacy == nil then stats.unknown = stats.unknown + 1 end
	return 'private'
end

local function copyLevel(service, src, parentObj, existing, opts, stats)
	for _, s in ipairs(src.sets) do
		if s.include ~= false then
			local ex = existing and existing.sets[s.name]
			local setObj
			if ex then
				setObj = ex.obj
			else
				setObj = service:createPublishedCollectionSet(s.name, parentObj, true)
				local vis = visibilityFor(s, opts.visibility, stats)
				setObj:setCollectionSetSettings { visibility = vis }
				stats.folders = stats.folders + 1
				if vis == 'private' then stats.privateFolders = stats.privateFolders + 1 end
			end
			copyLevel(service, s, setObj, ex, opts, stats)
		end
	end
	for _, c in ipairs(src.collections) do
		if c.include ~= false then
			local ex = existing and existing.collections[c.name]
			if ex then
				if not ex.smart and not c.smart and #c.photos > 0 then
					ex.obj:addPhotos(c.photos)
				end
				stats.existing = stats.existing + 1
			else
				local obj
				if c.smart and c.search then
					obj = service:createPublishedSmartCollection(c.name, c.search, parentObj, true)
					stats.smart = stats.smart + 1
				else
					obj = service:createPublishedCollection(c.name, parentObj, true)
					if #c.photos > 0 then obj:addPhotos(c.photos) end
				end
				local vis = visibilityFor(c, opts.visibility, stats)
				obj:setCollectionSettings { visibility = vis, allowDownload = opts.allowDownload == true }
				stats.albums = stats.albums + 1
				if vis == 'private' then
					stats.privateAlbums = stats.privateAlbums + 1
				else
					stats.publicAlbums = stats.publicAlbums + 1
				end
			end
		end
	end
end

-- Dialoger --------------------------------------------------------------------------

local function plural(n, one, many)
	return tostring(n) .. ' ' .. (n == 1 and one or many)
end

local function chooseSource(context, sources, labels)
	if #sources == 1 then return sources[1] end
	local f = LrView.osFactory()
	local props = LrBinding.makePropertyTable(context)
	props.source = 1
	local items = {}
	for i, label in ipairs(labels) do items[#items + 1] = { title = label, value = i } end
	local result = LrDialogs.presentModalDialog {
		title = 'Kopier album til Foto',
		contents = f:column {
			bind_to_object = props,
			spacing = f:control_spacing(),
			f:static_text { title = 'Hvilken publiseringstjeneste vil du kopiere mapper og album fra?' },
			f:popup_menu { value = LrView.bind 'source', items = items },
		},
		actionVerb = 'Fortsett',
		cancelVerb = 'Avbryt',
	}
	if result ~= 'ok' then return nil end
	return sources[props.source]
end

local function run(context)
	LrDialogs.attachErrorDialogToFunctionContext(context)
	local catalog = LrApplication.activeCatalog()

	local fotoServices = catalog:getPublishServices(_PLUGIN.id) or {}
	if #fotoServices == 0 then
		LrDialogs.message(
			'Lag Foto-tjenesten først',
			'Klikk + i panelet «Publiser tjenester» → «Gå til Administrasjon av publisering …», velg Foto, '
				.. 'trykk «Koble til Foto …» og lagre. Kjør så denne kopieringen igjen.',
			'info'
		)
		return
	end

	local isFoto = {}
	for _, s in ipairs(fotoServices) do isFoto[s.localIdentifier] = true end
	local smugmug, others = {}, {}
	for _, s in ipairs(catalog:getPublishServices() or {}) do
		if not isFoto[s.localIdentifier] then
			local okId, pluginId = LrTasks.pcall(function() return s:getPluginId() end)
			if okId and pluginId == SMUGMUG_PLUGIN then smugmug[#smugmug + 1] = s else others[#others + 1] = s end
		end
	end
	local sources, labels = {}, {}
	for _, list in ipairs { smugmug, others } do
		for _, s in ipairs(list) do
			sources[#sources + 1] = s
			labels[#labels + 1] = s:getName()
		end
	end
	if #sources == 0 then
		LrDialogs.message('Fant ingen andre publiseringstjenester å kopiere fra.', nil, 'info')
		return
	end

	local source = chooseSource(context, sources, labels)
	if not source then return end
	local sourceName = source:getName()
	local okId, sourcePlugin = LrTasks.pcall(function() return source:getPluginId() end)
	local fromSmugMug = okId and sourcePlugin == SMUGMUG_PLUGIN

	local tree = readSource(source)
	if #tree.sets == 0 and #tree.collections == 0 then
		LrDialogs.message('«' .. sourceName .. '» er tom', 'Det finnes ingen mapper eller album å kopiere.', 'info')
		return
	end

	-- Hoveddialogen ------------------------------------------------------------------
	local f = LrView.osFactory()
	local bind = LrView.bind
	local props = LrBinding.makePropertyTable(context)
	props.target = 1
	props.visibility = fromSmugMug and 'source' or 'private'
	props.allowDownload = false

	local top = {}
	local checkboxes = { spacing = f:label_spacing() }
	for _, s in ipairs(tree.sets) do
		top[#top + 1] = s
		local key = 'include' .. #top
		props[key] = true
		checkboxes[#checkboxes + 1] = f:checkbox {
			title = 'Mappe «' .. s.name .. '» – ' .. plural(countAlbums(s), 'album', 'album'),
			value = bind(key),
		}
	end
	for _, c in ipairs(tree.collections) do
		top[#top + 1] = c
		local key = 'include' .. #top
		props[key] = true
		checkboxes[#checkboxes + 1] = f:checkbox {
			title = 'Album «' .. c.name .. '» – ' .. plural(#c.photos, 'bilde', 'bilder'),
			value = bind(key),
		}
	end

	local targetItems = {}
	for i, s in ipairs(fotoServices) do targetItems[#targetItems + 1] = { title = s:getName(), value = i } end

	local visibilityItems = {}
	if fromSmugMug then
		visibilityItems[#visibilityItems + 1] = { title = 'Som på SmugMug (Public blir offentlig, alt annet privat)', value = 'source' }
	end
	visibilityItems[#visibilityItems + 1] = { title = 'Alle private – du gjør dem offentlige selv', value = 'private' }
	visibilityItems[#visibilityItems + 1] = { title = 'Alle offentlige', value = 'public' }

	local nAlbums, nPhotos = countAlbums(tree), countPhotos(tree, {})
	local contents = f:column {
		bind_to_object = props,
		spacing = f:control_spacing(),
		fill_horizontal = 1,
		f:static_text {
			title = 'Kopierer mapper og album fra «' .. sourceName .. '» til Foto (' .. plural(nAlbums, 'album', 'album')
				.. ', ' .. plural(nPhotos, 'bilde', 'bilder') .. ' totalt).',
			fill_horizontal = 1,
		},
		f:row {
			f:static_text { title = 'Til:', alignment = 'right', width = LrView.share 'fotoCopyLabel' },
			#fotoServices > 1 and f:popup_menu { value = bind 'target', items = targetItems }
				or f:static_text { title = fotoServices[1]:getName() },
		},
		f:row {
			f:static_text { title = 'Ta med:', alignment = 'right', width = LrView.share 'fotoCopyLabel' },
			f:scrolled_view {
				width = 460,
				height = math.min(280, 26 * #top + 16),
				horizontal_scroller = false,
				f:column(checkboxes),
			},
		},
		f:row {
			f:static_text { title = 'Synlighet:', alignment = 'right', width = LrView.share 'fotoCopyLabel' },
			f:popup_menu { value = bind 'visibility', items = visibilityItems },
		},
		f:row {
			f:spacer { width = LrView.share 'fotoCopyLabel' },
			f:checkbox { title = 'Tillat nedlasting av originaler i de nye albumene', value = bind 'allowDownload' },
		},
		f:static_text {
			title = 'Bare Lightroom endres: det lages mapper og album under Foto med de samme bildene. '
				.. 'Ingenting lastes opp før du trykker «Publiser», og «' .. sourceName .. '» røres ikke. '
				.. 'Det som finnes fra før under Foto, får bare nye bilder – innstillingene endres ikke.',
			fill_horizontal = 1,
			width_in_chars = 60,
			height_in_lines = 4,
		},
	}

	local result = LrDialogs.presentModalDialog {
		title = 'Kopier album til Foto',
		contents = contents,
		actionVerb = 'Kopier',
		cancelVerb = 'Avbryt',
	}
	if result ~= 'ok' then return end

	local anything = false
	for i, item in ipairs(top) do
		item.include = props['include' .. i] == true
		anything = anything or item.include
	end
	if not anything then return end

	local target = fotoServices[props.target] or fotoServices[1]
	local existing = readTarget(target)
	local opts = { visibility = props.visibility, allowDownload = props.allowDownload == true }
	local stats = {
		folders = 0, privateFolders = 0, albums = 0, publicAlbums = 0, privateAlbums = 0,
		smart = 0, existing = 0, unknown = 0,
	}
	Log.info('Kopierer fra', sourceName, 'til', target:getName(), 'synlighet:', opts.visibility, 'nedlasting:', tostring(opts.allowDownload))
	local status = catalog:withWriteAccessDo('Kopier album til Foto', function()
		copyLevel(target, tree, nil, existing, opts, stats)
	end, { timeout = 60 })
	if status == 'aborted' then
		LrDialogs.message('Lightroom var opptatt', 'Katalogen var låst av en annen jobb. Prøv igjen om litt.', 'warning')
		return
	end

	Log.info('Kopiert:', stats.folders, 'mapper,', stats.albums, 'album (', stats.publicAlbums, 'offentlige,',
		stats.privateAlbums, 'private ),', stats.existing, 'fantes fra før,', stats.unknown, 'med ukjent synlighet')

	local lines = {}
	lines[#lines + 1] = 'Nytt under «' .. target:getName() .. '»: ' .. plural(stats.folders, 'mappe', 'mapper') .. ' og '
		.. plural(stats.albums, 'album', 'album') .. ' (' .. stats.publicAlbums .. ' offentlige, ' .. stats.privateAlbums .. ' private).'
	if stats.existing > 0 then
		lines[#lines + 1] = plural(stats.existing, 'album', 'album') .. ' fantes fra før og fikk bare eventuelle nye bilder.'
	end
	if stats.unknown > 0 then
		lines[#lines + 1] = plural(stats.unknown, 'mappe eller album', 'mapper og album')
			.. ' hadde ukjent synlighet i SmugMug og ble satt som private.'
	end
	lines[#lines + 1] = 'Se over strukturen, og trykk «Publiser» på Foto-tjenesten når du er klar. '
		.. 'Synlighet og nedlasting endrer du med høyreklikk på albumet eller mappa → Rediger.'
	LrDialogs.message('Kopiert til Foto', table.concat(lines, '\n\n'), 'info')
end

LrTasks.startAsyncTask(function()
	LrFunctionContext.callWithContext('Foto: kopier album', run)
end)
