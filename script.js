/* ===========================================================
   DID Awards - Script Principal
   - Funcionalidades para todas las páginas
   - Cuenta regresiva y calendario para home
   - Sistema de votación para voting.html
=========================================================== */

const DID = (() => {
  // 🔒 Usar configuración del archivo config.js o valores por defecto
  const ADMIN_PIN = (window.DID_CONFIG && window.DID_CONFIG.ADMIN_PIN) || 'DID2025';
  const adminEmails = (window.DID_CONFIG && window.DID_CONFIG.adminEmails) || ['ppedemontev@udd.cl', 'coordinador@udd.cl'];

  // Estado
  let db = null;
  let currentUser = null;
  let currentUserRole = null;
  let currentUserGeneration = null;
  let currentVerificationCode = null;
  let candidates = [];
  let categories = [];
  let currentCategoryIndex = 0;
  let userVotes = {};

  // Config persistida (usar archivo config.js como base)
  let config = { 
    firebase: (window.DID_CONFIG && window.DID_CONFIG.firebase) || null, 
    emailjs: (window.DID_CONFIG && window.DID_CONFIG.emailjs) || null 
  };

  // Helpers DOM
  const $ = (id) => document.getElementById(id);
  const show = (el, v) => { if (el) el.style.display = v ? '' : 'none'; };
  const isProd = () => !['localhost','127.0.0.1'].includes(location.hostname);
  const searchHasConfig = () => {
    const sp = new URLSearchParams(location.search);
    return sp.get('config') === '1' || location.hash === '#config' || localStorage.getItem('forceConfig') === '1';
  };

  function showMessage(element, message, type) {
    if (!element) return;
    element.innerHTML = `<div class="${type}-message">${message}</div>`;
    setTimeout(() => { element.innerHTML = ''; }, 5000);
  }
  function showLoading(flag){ const l = $('loading'); if (l) l.style.display = flag ? 'block' : 'none'; }
  const validEmail = (e)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const validUrl = (u)=>{ try{ new URL(u); return true; } catch{ return false; } };
  
  // Verificar acceso a categorías según tipo
  function checkCategoryAccess(category, userRole, userGeneration) {
    if (!category.type) return true; // Sin tipo definido = acceso libre (compatibilidad)
    
    switch(category.type) {
      case 'academic':
        // Solo profesores pueden votar
        return userRole === 'professor';
        
      case 'community':
        // Solo alumnos de la misma generación pueden votar
        if (userRole !== 'student') return false;
        if (!category.generation) return true; // Si no tiene generación definida, permitir a todos los alumnos
        return userGeneration === category.generation;
        
      case 'teacher':
        // Todos los alumnos pueden votar (cualquier generación)
        return userRole === 'student';
        
      default:
        return true; // Tipo desconocido = acceso libre
    }
  }

  // ---------- Config ----------
  function loadConfiguration(){
    try{ const s = localStorage.getItem('voting-config'); if (s) config = JSON.parse(s) || config; } catch{}
  }
  function prefillConfigFields(){
    if (config.firebase){ $('firebase-api-key').value = config.firebase.apiKey || ''; $('firebase-project-id').value = config.firebase.projectId || ''; }
    if (config.emailjs){ $('emailjs-service-id').value = config.emailjs.serviceId || ''; $('emailjs-template-id').value = config.emailjs.templateId || ''; $('emailjs-public-key').value = config.emailjs.publicKey || ''; }
  }
  function saveConfiguration(){
    const msg = $('config-message');
    const firebaseConfig = {
      apiKey: $('firebase-api-key').value.trim(),
      authDomain: `${$('firebase-project-id').value.trim()}.firebaseapp.com`,
      projectId: $('firebase-project-id').value.trim(),
      storageBucket: `${$('firebase-project-id').value.trim()}.appspot.com`,
      messagingSenderId: '123456789',
      appId: '1:123456789:web:abcdef123456789'
    };
    const emailjsConfig = {
      serviceId: $('emailjs-service-id').value.trim(),
      templateId: $('emailjs-template-id').value.trim(),
      publicKey: $('emailjs-public-key').value.trim()
    };

    if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !emailjsConfig.serviceId || !emailjsConfig.templateId || !emailjsConfig.publicKey)
      return showMessage(msg, 'Por favor completa todos los campos', 'error');
    if (!emailjsConfig.serviceId.startsWith('service_'))
      return showMessage(msg, 'Service ID debe empezar con "service_"', 'error');
    if (!emailjsConfig.templateId.startsWith('template_'))
      return showMessage(msg, 'Template ID debe empezar con "template_"', 'error');

    config = { firebase: firebaseConfig, emailjs: emailjsConfig };
    localStorage.setItem('voting-config', JSON.stringify(config));
    showMessage(msg, 'Configuración guardada ✅', 'success');

    setTimeout(()=>{ hideConfiguration(); initializeServices(); show($('login-section'), true); }, 800);
  }
  function tryShowConfiguration(){
    if (!isProd()) return showConfiguration();
    const pin = prompt('Ingresa el PIN de administrador:');
    if (pin === ADMIN_PIN){ localStorage.setItem('forceConfig','1'); showConfiguration(); }
    else alert('PIN incorrecto.');
  }
  function showConfiguration(){
    prefillConfigFields();
    show($('config-section'), true);
    show($('login-section'), false);
    show($('verification-section'), false);
    show($('voting-section'), false);
    show($('admin-section'), false);
  }
  function hideConfiguration(){ show($('config-section'), false); }

  // ---------- Servicios ----------
  function initializeServices(){
    try{
      if (!config.firebase || !config.emailjs) return;
      const app = window.firebaseModules.initializeApp(config.firebase);
      db = window.firebaseModules.getFirestore(app);
      emailjs.init(config.emailjs.publicKey);
      // Pre-carga
      loadCategories();
      loadCandidates();
    }catch(e){
      console.error('Error inicializando servicios:', e);
      // NO alert en otras páginas; esto solo corre en voting.
      showMessage($('config-message'), 'Error en Firebase/EmailJS. Revisa las credenciales.', 'error');
    }
  }

  // ---------- Auth simple ----------
  async function sendVerificationCode(){
    const email = $('email').value.trim().toLowerCase();
    const msg = $('login-message');

    if (!config.emailjs || !config.emailjs.serviceId || !config.emailjs.templateId || !config.emailjs.publicKey)
      return showMessage(msg, 'Config de EmailJS incompleta. Abre Configuración.', 'error');
    if (!email.endsWith('@udd.cl')) return showMessage(msg, 'Solo correos @udd.cl', 'error');
    if (!validEmail(email)) return showMessage(msg, 'Correo no válido', 'error');

    showLoading(true);
    try{
      // Verificar usuario en base de datos y obtener rol
      if (db) {
        try {
          const userRef = window.firebaseModules.doc(db, 'users', email);
          const userSnap = await window.firebaseModules.getDoc(userRef);
          
          if (userSnap.exists()) {
            const userData = userSnap.data();
            currentUserRole = userData.role;
            console.log(`Usuario verificado: ${email} - Rol: ${currentUserRole}`);
            // La generación se preguntará después si es estudiante
          } else {
            showMessage(msg, 'Usuario no encontrado en la base de datos', 'error');
            showLoading(false);
            return;
          }
        } catch (firebaseError) {
          console.warn('Error verificando usuario:', firebaseError);
          showMessage(msg, 'Error verificando usuario. Contacta al administrador.', 'error');
          showLoading(false);
          return;
        }
      }

      // chequear ya votó (solo si Firebase está configurado)
      if (db) {
        try {
          const votesRef = window.firebaseModules.collection(db, 'votes');
          const q = window.firebaseModules.query(votesRef, window.firebaseModules.where('email','==',email));
          const qs = await window.firebaseModules.getDocs(q);
          if (!qs.empty){ showMessage(msg, 'Este correo ya fue utilizado para votar', 'error'); showLoading(false); return; }
        } catch (firebaseError) {
          console.warn('Error verificando votos previos (continuando):', firebaseError);
          // Continuar sin verificar si hay error de permisos
        }
      }

      currentVerificationCode = String(Math.floor(100000 + Math.random()*900000));
      currentUser = email;

      const emailParams = {
        to_email: email, verification_code: currentVerificationCode,
        user_name: email.split('@')[0], reply_to: email,
        from_name: 'DID Awards', to_name: email.split('@')[0]
      };
      await emailjs.send(config.emailjs.serviceId, config.emailjs.templateId, emailParams);

      show($('login-section'), false);
      show($('verification-section'), true);
      showMessage(msg, 'Código enviado a tu correo ✅', 'success');
    }catch(e){
      console.error('Error enviando código:', e);
      
      // Determinar si es error de Firebase o EmailJS
      if (e.message && e.message.includes('permissions')) {
        showMessage(msg, 'Error de permisos en Firebase. Revisa la configuración.', 'error');
      } else if (e.message && e.message.includes('Firebase')) {
        showMessage(msg, 'Error de Firebase. Revisa la configuración.', 'error');
      } else {
        showMessage(msg, 'Error enviando código. Revisa EmailJS.', 'error');
      }
    }
    showLoading(false);
  }

  function verifyCode(){
    const input = $('verification-input').value.trim();
    const msg = $('verification-message');
    if (input === currentVerificationCode){
      showMessage(msg, 'Verificación exitosa ✅', 'success');
      show($('verification-section'), false);
      
      // Si es estudiante, mostrar selección de generación
      if (currentUserRole === 'student') {
        show($('generation-selection-section'), true);
        console.log('Usuario es estudiante, mostrando selección de generación');
      } else {
        // Si es profesor o invitado, ir directo a votación
        console.log('Usuario no es estudiante, iniciando votación directamente');
        startVoting();
      }
    }else{
      showMessage(msg, 'Código incorrecto', 'error');
    }
  }
  
  function confirmGeneration(){
    const generation = $('generation-select').value;
    const msg = $('generation-message');
    
    if (!generation) {
      return showMessage(msg, 'Por favor selecciona tu generación', 'error');
    }
    
    currentUserGeneration = generation;
    console.log(`Generación seleccionada: ${generation}° año`);
    showMessage(msg, '✅ Generación confirmada', 'success');
    
    setTimeout(() => {
      show($('generation-selection-section'), false);
      startVoting();
    }, 500);
  }
  
  function startVoting(){
    show($('voting-section'), true);
    show($('user-bar'), true);
    $('navbar-user-email').textContent = currentUser;
    // habilitar admin si corresponde
    if (adminEmails.includes(currentUser)) show($('admin-access'), true);
    displayCandidates();
  }

  // ---------- Datos ----------
  async function loadCategories(){
    if (!db) {
      // Si no hay Firebase, usar datos de ejemplo
      loadExampleData();
      return;
    }
    try{
      const ref = window.firebaseModules.collection(db, 'categories');
      const snap = await window.firebaseModules.getDocs(ref);
      categories = []; snap.forEach(d=>categories.push({id:d.id, ...d.data()}));
      
      // Si no hay categorías, cargar datos de ejemplo
      if (categories.length === 0) {
        loadExampleData();
        return;
      }
      
      // poblar select admin
      const sel = $('candidate-category'); if (sel){
        sel.innerHTML = '<option value="">Selecciona una categoría</option>';
        categories.forEach(c=>{ const opt=document.createElement('option'); opt.value=c.id; opt.textContent=c.name; sel.appendChild(opt); });
      }
    }catch(e){ 
      console.error('Error categorías:', e); 
      loadExampleData();
    }
  }
  
  async function loadCandidates(){
    if (!db) {
      loadExampleData();
      return;
    }
    try{
      const ref = window.firebaseModules.collection(db, 'candidates');
      const snap = await window.firebaseModules.getDocs(ref);
      candidates = []; snap.forEach(d=>candidates.push({id:d.id, ...d.data()}));
      
      // Si no hay candidatos, cargar datos de ejemplo
      if (candidates.length === 0) {
        loadExampleData();
        return;
      }
      
      if ($('voting-section') && $('voting-section').style.display !== 'none') displayCandidates();
      displayCandidatesForAdmin();
    }catch(e){ 
      console.error('Error candidatos:', e); 
      loadExampleData();
    }
  }
  
  // Datos de ejemplo para demostración
  function loadExampleData() {
    console.log('Cargando datos de ejemplo...');
    
    categories = [
      { id: 'cat1', name: 'Mejor Proyecto de Software', description: 'Proyectos innovadores en desarrollo de software' },
      { id: 'cat2', name: 'Mejor Diseño UX/UI', description: 'Experiencias de usuario excepcionales' },
      { id: 'cat3', name: 'Mejor Proyecto de Hardware', description: 'Innovaciones en hardware y dispositivos' }
    ];
    
    candidates = [
      {
        id: 'cand1',
        name: 'EcoTracker App',
        description: 'Aplicación móvil para seguimiento de huella de carbono personal',
        categoryId: 'cat1',
        image: 'https://images.unsplash.com/photo-1551650975-87deedd944c3?w=400&h=400&fit=crop&crop=face',
        projectImage: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&h=400&fit=crop'
      },
      {
        id: 'cand2',
        name: 'SmartHome Hub',
        description: 'Sistema centralizado para automatización del hogar',
        categoryId: 'cat1',
        image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop&crop=face',
        projectImage: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&h=400&fit=crop'
      },
      {
        id: 'cand3',
        name: 'HealthConnect',
        description: 'Plataforma de telemedicina con IA para diagnóstico',
        categoryId: 'cat1',
        image: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=400&h=400&fit=crop&crop=face',
        projectImage: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1f?w=600&h=400&fit=crop'
      },
      {
        id: 'cand4',
        name: 'DesignFlow',
        description: 'Herramienta de diseño colaborativo en tiempo real',
        categoryId: 'cat2',
        image: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&h=400&fit=crop&crop=face',
        projectImage: 'https://images.unsplash.com/photo-1558655146-d09347e92766?w=600&h=400&fit=crop'
      },
      {
        id: 'cand5',
        name: 'EduPlatform',
        description: 'Interfaz de aprendizaje adaptativo con gamificación',
        categoryId: 'cat2',
        image: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&h=400&fit=crop&crop=face',
        projectImage: 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=600&h=400&fit=crop'
      },
      {
        id: 'cand6',
        name: 'Quantum Sensor',
        description: 'Sensor cuántico para detección de materiales',
        categoryId: 'cat3',
        image: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=400&fit=crop&crop=face',
        projectImage: 'https://images.unsplash.com/photo-1581092160562-40aa08e78837?w=600&h=400&fit=crop'
      }
    ];
    
    // Poblar select admin
    const sel = $('candidate-category'); 
    if (sel) {
      sel.innerHTML = '<option value="">Selecciona una categoría</option>';
      categories.forEach(c => { 
        const opt = document.createElement('option'); 
        opt.value = c.id; 
        opt.textContent = c.name; 
        sel.appendChild(opt); 
      });
    }
    
    if ($('voting-section') && $('voting-section').style.display !== 'none') displayCandidates();
    displayCandidatesForAdmin();
  }

  // ---------- Votación ----------
  function displayCandidates(){
    const cont = $('candidates');
    cont.innerHTML = '';

    if (!categories.length){
      cont.innerHTML = '<div class="info-message" style="grid-column:1/-1;text-align:center;padding:40px;">No hay categorías disponibles.</div>';
      $('skip-btn').style.display = 'none'; return;
    }
    if (currentCategoryIndex >= categories.length) return displayVotingComplete();

    const category = categories[currentCategoryIndex];
    
    // Sistema de filtrado por tipo de categoría
    if (category.type) {
      const canVote = checkCategoryAccess(category, currentUserRole, currentUserGeneration);
      
      if (!canVote) {
        console.log(`⛔ Categoría ${category.name} (${category.type}) no permitida para usuario actual`);
        console.log(`   Usuario: Rol=${currentUserRole}, Generación=${currentUserGeneration || 'N/A'}`);
        console.log(`   Categoría: Tipo=${category.type}, Generación=${category.generation || 'N/A'}`);
        nextCategory();
        return;
      }
      
      console.log(`✅ Categoría ${category.name} (${category.type}) - Acceso permitido`);
    } else {
      // Compatibilidad con categorías antiguas (sin tipo definido)
      if (category.allowedRoles && category.allowedRoles.length > 0 && !category.allowedRoles.includes(currentUserRole)) {
        console.log(`Categoría ${category.name} no permitida para rol ${currentUserRole}. Roles permitidos: ${category.allowedRoles}`);
        nextCategory();
        return;
      }
      console.log(`Categoría ${category.name} - Sistema antiguo de roles`);
    }
    
    const list = candidates.filter(c=>c.categoryId === category.id);

    // header mejorado
    const header = document.createElement('div');
    header.className = 'info-message';
    header.style.cssText = `
      grid-column: 1/-1; text-align: center; padding: 24px; margin-bottom: 20px;
      background: linear-gradient(135deg, rgba(255,103,152,0.1) 0%, rgba(147,9,61,0.1) 100%);
      border: 2px solid rgba(255,103,152,0.3); border-radius: 16px;
    `;
    header.innerHTML = `
      <h3 style="color: var(--accent-medium); margin-bottom: 8px; font-size: 1.5rem;">${category.name}</h3>
      <p style="opacity: 0.9; margin: 0; font-size: 1.1rem;">${category.description || ''}</p>
    `;
    cont.appendChild(header);

    if (!list.length){
      cont.innerHTML += '<div class="info-message" style="grid-column:1/-1;text-align:center;padding:40px;">No hay candidatos en esta categoría.</div>';
      $('skip-btn').style.display = 'inline-block';
      $('vote-btn').style.display = 'none';
      return;
    }

    list.forEach((c, idx)=>{
      const div = document.createElement('div');
      div.className = 'candidate-option';
      div.onclick = ()=>selectCandidate(div, c.id);

      const projectImg = c.projectImage ? `<img src="${c.projectImage}" alt="Proyecto de ${c.name}" class="candidate-project-image" onerror="this.style.display='none'">` : '';
      const profileImg = c.image ? `<img src="${c.image}" alt="${c.name}" class="candidate-image" onerror="this.style.display='none'">` : '';

      div.innerHTML = `
        <input type="radio" name="candidate" value="${c.id}" id="opt${idx}" style="position:absolute;opacity:0;">
        <div class="candidate-header">
          ${projectImg}
        </div>
        <div class="candidate-content">
          <div class="candidate-layout">
            ${profileImg}
            <div class="candidate-info">
              <div class="candidate-name">${c.name}</div>
              <div class="candidate-description">${c.description || ''}</div>
            </div>
          </div>
        </div>
      `;
      cont.appendChild(div);
    });

    $('skip-btn').style.display = 'inline-block';
    $('vote-btn').style.display = 'inline-block';
    $('vote-btn').disabled = true; // Se habilita cuando se selecciona un candidato
  }
  function selectCandidate(el, id){
    document.querySelectorAll('.candidate-option').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    el.querySelector('input[type="radio"]').checked = true;
    $('vote-btn').disabled = false;
  }
  async function submitVote(){
    const selected = document.querySelector('input[name="candidate"]:checked');
    const msg = $('vote-message');
    if (!selected) return showMessage(msg, 'Selecciona un candidato', 'error');

    showLoading(true);
    try{
      const candidateId = selected.value;
      const category = categories[currentCategoryIndex];

      // Validar que el email sea válido
      if (!currentUser || !currentUser.endsWith('@udd.cl')) {
        showMessage(msg, 'Email no válido', 'error');
        showLoading(false);
        return;
      }

      // Verificar que no haya votado ya en esta categoría
      const votesRef = window.firebaseModules.collection(db, 'votes');
      const q = window.firebaseModules.query(votesRef, 
        window.firebaseModules.where('email', '==', currentUser),
        window.firebaseModules.where('categoryId', '==', category.id)
      );
      const existingVotes = await window.firebaseModules.getDocs(q);
      
      if (!existingVotes.empty) {
        showMessage(msg, 'Ya has votado en esta categoría', 'error');
        showLoading(false);
        return;
      }

      // guardar voto
      await window.firebaseModules.addDoc(window.firebaseModules.collection(db, 'votes'), {
        email: currentUser, 
        candidateId, 
        categoryId: category.id, 
        timestamp: new Date(), 
        userAgent: navigator.userAgent,
        ipAddress: 'unknown' // Se puede obtener con servicios externos si es necesario
      });

      // update contador
      const candidate = candidates.find(c=>c.id===candidateId);
      const newVotes = (candidate.votes || 0) + 1;
      await window.firebaseModules.updateDoc(window.firebaseModules.doc(window.firebaseModules.collection(db,'candidates'), candidateId), { votes:newVotes });
      candidate.votes = newVotes;

      userVotes[category.id] = candidateId;
      showMessage(msg, `¡Voto registrado por: ${candidate.name}!`, 'success');
      setTimeout(nextCategory, 1200);
    }catch(e){
      console.error('Error registrando voto:', e);
      if (e.message && e.message.includes('permissions')) {
        showMessage(msg, 'Error de permisos en Firebase. Contacta al administrador.', 'error');
      } else {
        showMessage(msg, 'Error registrando el voto', 'error');
      }
    }
    showLoading(false);
  }
  function skipCategory(){
    const category = categories[currentCategoryIndex];
    userVotes[category.id] = null;
    nextCategory();
  }
  function nextCategory(){
    currentCategoryIndex++;
    if (currentCategoryIndex >= categories.length) return displayVotingComplete();
    $('vote-btn').disabled = true;
    displayCandidates();
  }
  function displayVotingComplete(){
    $('candidates').innerHTML = `
      <div class="info-message" style="text-align:center;padding:30px;">
        <h3><span class="material-icons">celebration</span> ¡Votación Completada!</h3>
        <p>Tus votos han sido registrados exitosamente.</p>
      </div>`;
    $('vote-btn').style.display = 'none';
    $('skip-btn').style.display = 'none';
  }

  // ---------- Admin ----------
  function showAdmin(){
    show($('voting-section'), false);
    show($('admin-section'), true);
    loadStats();
    displayCandidatesForAdmin();
  }
  function backToVoting(){
    show($('admin-section'), false);
    show($('voting-section'), true);
  }
  async function addCategory(){
    const name = $('category-name').value.trim();
    const description = $('category-description').value.trim();
    const type = $('category-type').value;
    const generation = $('category-generation').value;
    const msg = $('admin-message');
    
    // Validar que sea un administrador
    if (!adminEmails.includes(currentUser)) {
      showMessage(msg, 'Solo administradores pueden agregar categorías', 'error');
      return;
    }
    
    if (!name || !description) return showMessage(msg, 'Completa nombre y descripción', 'error');
    if (name.length < 3) return showMessage(msg, 'El nombre debe tener al menos 3 caracteres', 'error');
    if (description.length < 10) return showMessage(msg, 'La descripción debe tener al menos 10 caracteres', 'error');
    
    if (!type) {
      return showMessage(msg, 'Selecciona el tipo de categoría', 'error');
    }
    
    // Validar que las categorías comunitarias tengan generación
    if (type === 'community' && !generation) {
      return showMessage(msg, 'Las categorías comunitarias requieren una generación', 'error');
    }
    
    try{
      const ref = window.firebaseModules.collection(db,'categories');
      const categoryData = { 
        name, 
        description, 
        type,
        createdAt: new Date(),
        createdBy: currentUser
      };
      
      // Solo agregar generación si es categoría comunitaria
      if (type === 'community') {
        categoryData.generation = generation;
      }
      
      await window.firebaseModules.addDoc(ref, categoryData);
      
      $('category-name').value=''; 
      $('category-description').value='';
      $('category-type').value='';
      $('category-generation').value='';
      $('generation-field').style.display = 'none';
      
      showMessage(msg, 'Categoría agregada ✅', 'success');
      loadCategories();
    }catch(e){ console.error(e); showMessage(msg,'Error agregando categoría','error'); }
  }
  async function addCandidate(){
    const categoryId = $('candidate-category').value;
    const name = $('candidate-name').value.trim();
    const description = $('candidate-description').value.trim();
    const image = $('candidate-image').value.trim();
    const projectImage = $('candidate-project-image').value.trim();
    const msg = $('admin-message');

    // Validar que sea un administrador
    if (!adminEmails.includes(currentUser)) {
      showMessage(msg, 'Solo administradores pueden agregar candidatos', 'error');
      return;
    }

    if (!categoryId || !name) return showMessage(msg, 'Selecciona categoría y nombre', 'error');
    if (name.length < 2) return showMessage(msg, 'El nombre debe tener al menos 2 caracteres', 'error');
    if (image && !validUrl(image)) return showMessage(msg, 'URL de imagen inválida', 'error');
    if (projectImage && !validUrl(projectImage)) return showMessage(msg, 'URL de imagen de proyecto inválida', 'error');

    try{
      await window.firebaseModules.addDoc(window.firebaseModules.collection(db,'candidates'), {
        categoryId, 
        name, 
        description, 
        image, 
        projectImage, 
        votes:0, 
        createdAt:new Date(),
        createdBy: currentUser
      });
      $('candidate-category').value=''; $('candidate-name').value=''; $('candidate-description').value='';
      $('candidate-image').value=''; $('candidate-project-image').value='';
      showMessage(msg,'Candidato agregado ✅','success');
      loadCandidates();
    }catch(e){ console.error(e); showMessage(msg,'Error agregando candidato','error'); }
  }
  async function deleteCandidate(id){
    // Validar que sea un administrador
    if (!adminEmails.includes(currentUser)) {
      showMessage($('admin-message'), 'Solo administradores pueden eliminar candidatos', 'error');
      return;
    }
    
    if (!confirm('¿Eliminar este candidato?')) return;
    try{
      await window.firebaseModules.deleteDoc(window.firebaseModules.doc(db,'candidates',id));
      showMessage($('admin-message'),'Candidato eliminado ✅','success');
      loadCandidates();
    }catch(e){ console.error(e); showMessage($('admin-message'),'Error eliminando candidato','error'); }
  }
  function displayCandidatesForAdmin(){
    const list = $('candidate-list'); if (!list) return;
    list.innerHTML = '';
    candidates.forEach(c=>{
      const cat = categories.find(k=>k.id===c.categoryId);
      const div = document.createElement('div');
      div.className = 'candidate-item info-card';
      div.style.textAlign='left';
      div.innerHTML = `
        <div><strong>${c.name}</strong><br>
          <small>Categoría: ${cat?cat.name:'(sin)'}</small><br>
          <small>${c.description || ''}</small><br>
          <small>Votos: ${c.votes || 0}</small>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-secondary" onclick="DID._deleteCandidate('${c.id}')">Eliminar</button>
        </div>`;
      list.appendChild(div);
    });
  }
  async function loadStats(){
    try{
      const votesSnap = await window.firebaseModules.getDocs(window.firebaseModules.collection(db,'votes'));
      const totalVotes = votesSnap.size;
      const totalCandidates = candidates.length;
      $('stats').innerHTML = `
        <div class="info-card"><div class="icon">🗳️</div><div class="stat-number" style="font-size:2rem;font-weight:700;color:var(--accent-medium);">${totalVotes}</div><div class="stat-label">Total Votos</div></div>
        <div class="info-card"><div class="icon">👥</div><div class="stat-number" style="font-size:2rem;font-weight:700;color:var(--accent-medium);">${totalCandidates}</div><div class="stat-label">Candidatos</div></div>
      `;
    }catch(e){ console.error('Error stats:', e); }
  }
  async function exportResults(){
    try{
      const votesSnap = await window.firebaseModules.getDocs(window.firebaseModules.collection(db,'votes'));
      const rows = [];
      votesSnap.forEach(d=>{
        const v = d.data();
        const c = candidates.find(x=>x.id===v.candidateId);
        const dateStr = v.timestamp && v.timestamp.toDate ? v.timestamp.toDate().toLocaleString() : new Date(v.timestamp).toLocaleString();
        rows.push({ email:v.email, candidate: c?c.name:'(desconocido)', timestamp: dateStr });
      });
      const csv = "Email,Candidato,Fecha\n" + rows.map(r=>`${r.email},${r.candidate},${r.timestamp}`).join("\n");
      const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href=url; a.download='resultados_votacion.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      showMessage($('admin-message'),'Resultados exportados ✅','success');
    }catch(e){ console.error(e); showMessage($('admin-message'),'Error exportando resultados','error'); }
  }
  async function clearAllData(){
    if (!confirm('¿Eliminar TODOS los datos (votos y candidatos)?')) return;
    try{
      // votos
      const vRef = window.firebaseModules.collection(db, 'votes');
      const vSnap = await window.firebaseModules.getDocs(vRef);
      await Promise.all(vSnap.docs.map(d=>window.firebaseModules.deleteDoc(d.ref)));
      // candidatos
      const cRef = window.firebaseModules.collection(db, 'candidates');
      const cSnap = await window.firebaseModules.getDocs(cRef);
      await Promise.all(cSnap.docs.map(d=>window.firebaseModules.deleteDoc(d.ref)));
      showMessage($('admin-message'),'Datos eliminados ✅','success');
      loadCandidates(); loadStats();
    }catch(e){ console.error(e); showMessage($('admin-message'),'Error eliminando datos','error'); }
  }
  async function resetVoting(){
    if (!confirm('¿Reiniciar votación? (elimina votos, mantiene candidatos)')) return;
    try{
      const vRef = window.firebaseModules.collection(db,'votes');
      const vSnap = await window.firebaseModules.getDocs(vRef);
      await Promise.all(vSnap.docs.map(d=>window.firebaseModules.deleteDoc(d.ref)));
      // resetear contadores candidatos
      const cRef = window.firebaseModules.collection(db,'candidates');
      const cSnap = await window.firebaseModules.getDocs(cRef);
      await Promise.all(cSnap.docs.map(d=>window.firebaseModules.updateDoc(d.ref,{votes:0})));
      showMessage($('admin-message'),'Votación reiniciada ✅','success');
      loadCandidates(); loadStats();
    }catch(e){ console.error(e); showMessage($('admin-message'),'Error reiniciando','error'); }
  }
  async function resetUserVotes(){
    const userEmail = prompt('Correo del usuario a resetear:');
    if (!userEmail) return;
    if (!confirm(`Resetear todos los votos de ${userEmail}?`)) return;
    try{
      const vRef = window.firebaseModules.collection(db,'votes');
      const q = window.firebaseModules.query(vRef, window.firebaseModules.where('email','==',userEmail.toLowerCase()));
      const snap = await window.firebaseModules.getDocs(q);
      if (snap.empty){ alert(`No hay votos para ${userEmail}`); return; }
      await Promise.all(snap.docs.map(d=>window.firebaseModules.deleteDoc(d.ref)));
      showMessage($('admin-message'),`Votos de ${userEmail} reseteados ✅`,'success');
      loadStats();
    }catch(e){ console.error(e); showMessage($('admin-message'),'Error reseteando votos','error'); }
  }
  async function viewUserVotes(){
    const userEmail = prompt('Correo del usuario a consultar:'); if (!userEmail) return;
    try{
      const vRef = window.firebaseModules.collection(db,'votes');
      const q = window.firebaseModules.query(vRef, window.firebaseModules.where('email','==',userEmail.toLowerCase()));
      const snap = await window.firebaseModules.getDocs(q);
      if (snap.empty) return alert(`No se encontraron votos para ${userEmail}`);
      let info = `Votos de ${userEmail}:\n\n`;
      snap.forEach(d=>{
        const v = d.data();
        const c = candidates.find(x=>x.id===v.candidateId);
        const k = categories.find(x=>x.id===v.categoryId);
        const dt = v.timestamp && v.timestamp.toDate ? v.timestamp.toDate().toLocaleString() : new Date(v.timestamp).toLocaleString();
        info += `• ${c?c.name:'(candidato)'} (${k?k.name:'(categoría)'}) - ${dt}\n`;
      });
      alert(info);
    }catch(e){ console.error(e); showMessage($('admin-message'),'Error viendo votos','error'); }
  }
  
  // ---------- Gestión de Usuarios ----------
  async function updateUserRole(){
    const userEmail = $('user-email').value.trim().toLowerCase();
    const newRole = $('user-role').value;
    const newGeneration = $('user-generation').value;
    const msg = $('admin-message');
    
    // Validar que sea un administrador
    if (!adminEmails.includes(currentUser)) {
      showMessage(msg, 'Solo administradores pueden modificar usuarios', 'error');
      return;
    }
    
    if (!userEmail || !newRole) {
      return showMessage(msg, 'Completa email y selecciona un rol', 'error');
    }
    
    // Validar que los estudiantes tengan generación
    if (newRole === 'student' && !newGeneration) {
      return showMessage(msg, 'Los estudiantes requieren una generación', 'error');
    }
    
    if (!userEmail.endsWith('@udd.cl')) {
      return showMessage(msg, 'Solo correos @udd.cl', 'error');
    }
    
    try{
      const userRef = window.firebaseModules.doc(db, 'users', userEmail);
      const userSnap = await window.firebaseModules.getDoc(userRef);
      
      if (!userSnap.exists()) {
        return showMessage(msg, 'Usuario no encontrado en la base de datos', 'error');
      }
      
      const updateData = {
        role: newRole,
        updatedAt: new Date(),
        updatedBy: currentUser
      };
      
      // Solo agregar generación si es estudiante
      if (newRole === 'student') {
        updateData.generation = newGeneration;
      } else {
        // Eliminar generación si ya no es estudiante
        updateData.generation = null;
      }
      
      await window.firebaseModules.updateDoc(userRef, updateData);
      
      const generationText = newRole === 'student' ? ` (${newGeneration}° año)` : '';
      showMessage(msg, `✅ Usuario actualizado: ${userEmail} ahora es ${newRole}${generationText}`, 'success');
      
      $('user-email').value = '';
      $('user-role').value = '';
      $('user-generation').value = '';
      $('user-generation-field').style.display = 'none';
      
    }catch(e){
      console.error(e);
      showMessage(msg, 'Error actualizando usuario', 'error');
    }
  }
  
  async function viewUserInfo(){
    const userEmail = $('user-email').value.trim().toLowerCase();
    const msg = $('admin-message');
    
    if (!userEmail) {
      return showMessage(msg, 'Ingresa un email para consultar', 'error');
    }
    
    try{
      const userRef = window.firebaseModules.doc(db, 'users', userEmail);
      const userSnap = await window.firebaseModules.getDoc(userRef);
      
      if (!userSnap.exists()) {
        return showMessage(msg, 'Usuario no encontrado en la base de datos', 'error');
      }
      
      const userData = userSnap.data();
      const roleEmoji = {
        'student': '👨‍🎓',
        'professor': '👨‍🏫',
        'guest': '👥'
      };
      
      let info = `📋 Información del Usuario:\n\n`;
      info += `📧 Email: ${userData.email}\n`;
      info += `👤 Nombre: ${userData.displayName}\n`;
      info += `${roleEmoji[userData.role] || '❓'} Rol: ${userData.role}\n`;
      if (userData.generation) {
        info += `🎓 Generación: ${userData.generation}° año\n`;
      }
      info += `✅ Activo: ${userData.isActive ? 'Sí' : 'No'}\n`;
      info += `📅 Creado: ${userData.createdAt ? userData.createdAt.toDate().toLocaleString() : 'N/A'}\n`;
      if (userData.updatedAt) {
        info += `🔄 Actualizado: ${userData.updatedAt.toDate().toLocaleString()}\n`;
      }
      
      alert(info);
      
      // Pre-llenar el formulario con la información
      $('user-role').value = userData.role;
      
      // Mostrar y pre-llenar generación si es estudiante
      if (userData.role === 'student' && userData.generation) {
        $('user-generation-field').style.display = 'block';
        $('user-generation').value = userData.generation;
      }
      
    }catch(e){
      console.error(e);
      showMessage(msg, 'Error consultando información del usuario', 'error');
    }
  }

  // ---------- Handlers de UI ----------
  function handleCategoryTypeChange() {
    const type = $('category-type').value;
    const generationField = $('generation-field');
    
    if (type === 'community') {
      generationField.style.display = 'block';
    } else {
      generationField.style.display = 'none';
      $('category-generation').value = '';
    }
  }
  
  function handleUserRoleChange() {
    const role = $('user-role').value;
    const generationField = $('user-generation-field');
    
    if (role === 'student') {
      generationField.style.display = 'block';
    } else {
      generationField.style.display = 'none';
      $('user-generation').value = '';
    }
  }

  // ---------- Sesión ----------
  function logout(){
    currentUser = null; currentUserRole = null; currentUserGeneration = null; currentVerificationCode = null; currentCategoryIndex = 0; userVotes = {};
    if ($('email')) $('email').value = '';
    if ($('verification-input')) $('verification-input').value = '';
    if ($('generation-select')) $('generation-select').value = '';
    show($('login-section'), true); 
    show($('verification-section'), false);
    show($('generation-selection-section'), false);
    show($('voting-section'), false); 
    show($('admin-section'), false);
    show($('admin-access'), false); 
    show($('user-bar'), false);
    const vm = $('vote-message'); if (vm) vm.innerHTML = '';
    const gm = $('generation-message'); if (gm) gm.innerHTML = '';
  }

  // ===========================================================
  // FUNCIONALIDADES PARA PÁGINA PRINCIPAL (HOME)
  // ===========================================================
  
  // Inicializar cuenta regresiva
  function initCountdown() {
    console.log('Inicializando cuenta regresiva...');
    const targetDate = new Date('2025-12-01T19:00:00').getTime(); // 1 de diciembre a las 19:00
    
    function updateCountdown() {
      const now = new Date().getTime();
      const timeLeft = targetDate - now;
      
      if (timeLeft > 0) {
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
        
        // Actualizar elementos DOM
        const daysEl = document.getElementById('days');
        const hoursEl = document.getElementById('hours');
        const minutesEl = document.getElementById('minutes');
        const secondsEl = document.getElementById('seconds');
        
        if (daysEl) daysEl.textContent = days.toString().padStart(2, '0');
        if (hoursEl) hoursEl.textContent = hours.toString().padStart(2, '0');
        if (minutesEl) minutesEl.textContent = minutes.toString().padStart(2, '0');
        if (secondsEl) secondsEl.textContent = seconds.toString().padStart(2, '0');
      } else {
        // El evento ya comenzó
        const countdownDisplay = document.getElementById('countdown');
        if (countdownDisplay) {
          countdownDisplay.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center;">
              <h2 style="color: var(--accent-medium); font-size: 2.5rem; margin: 0;">
                <span class="material-icons">celebration</span> ¡El evento está en curso!
              </h2>
              <p style="color: rgba(255,255,255,0.8); font-size: 1.2rem; margin: 10px 0 0 0;">
                DID Awards 2025 - 1 de diciembre
              </p>
            </div>
          `;
        }
      }
    }
    
    // Actualizar inmediatamente y luego cada segundo
    updateCountdown();
    setInterval(updateCountdown, 1000);
  }

  // Configurar botón de calendario
  function setupCalendarButton() {
    const calendarBtn = document.getElementById('add-to-calendar');
    
    if (calendarBtn) {
      calendarBtn.addEventListener('click', function(e) {
        e.preventDefault();
        addToCalendar();
      });
    }
  }

  function addToCalendar() {
    // Detalles del evento
    const eventDetails = {
      title: 'DID AWARDS 2025',
      description: 'Ceremonia de premios de la Universidad del Desarrollo - Reconociendo la excelencia y la innovación',
      location: 'Fuera de aula magna UDD',
      startDate: '20251201T190000', // 1 de diciembre 2025, 19:00
      endDate: '20251201T220000',   // 1 de diciembre 2025, 22:00
      timezone: 'America/Santiago'
    };
    
    // Crear URLs para diferentes calendarios
    const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(eventDetails.title)}&dates=${eventDetails.startDate}/${eventDetails.endDate}&details=${encodeURIComponent(eventDetails.description)}&location=${encodeURIComponent(eventDetails.location)}`;
    
    const outlookUrl = `https://outlook.live.com/calendar/0/deeplink/compose?subject=${encodeURIComponent(eventDetails.title)}&startdt=${eventDetails.startDate}&enddt=${eventDetails.endDate}&body=${encodeURIComponent(eventDetails.description)}&location=${encodeURIComponent(eventDetails.location)}`;
    
    // Crear elemento .ics para descarga directa
    const icsContent = createICSFile(eventDetails);
    
    // Mostrar opciones de calendario
    showCalendarOptions(googleUrl, outlookUrl, icsContent, eventDetails.title);
  }

  function createICSFile(eventDetails) {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//DID Awards//Calendar Event//EN',
      'BEGIN:VEVENT',
      `UID:did-awards-2025@udd.cl`,
      `DTSTART:${eventDetails.startDate}`,
      `DTEND:${eventDetails.endDate}`,
      `SUMMARY:${eventDetails.title}`,
      `DESCRIPTION:${eventDetails.description}`,
      `LOCATION:${eventDetails.location}`,
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT1H',
      'ACTION:DISPLAY',
      'DESCRIPTION:Recordatorio: DID Awards en 1 hora',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    
    return ics;
  }

  function showCalendarOptions(googleUrl, outlookUrl, icsContent, eventTitle) {
    // Crear modal con opciones
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      backdrop-filter: blur(10px);
    `;
    
    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary-medium) 100%);
      border: 2px solid var(--accent-medium);
      border-radius: 20px;
      padding: 40px;
      max-width: 500px;
      width: 90%;
      text-align: center;
      color: white;
      font-family: 'Fira Code', monospace;
    `;
    
    modalContent.innerHTML = `
      <h2 style="color: var(--accent-medium); margin-bottom: 20px; font-size: 1.8rem;">
        <span class="material-icons">event</span> Agregar a Calendario
      </h2>
      <p style="margin-bottom: 30px; color: rgba(255,255,255,0.8);">
        Elige cómo quieres agregar el evento DID AWARDS 2025
      </p>
      
      <div style="display: flex; flex-direction: column; gap: 15px; margin-bottom: 30px;">
        <a href="${googleUrl}" target="_blank" style="
          background: linear-gradient(135deg, var(--accent-medium) 0%, var(--accent-light) 100%);
          color: white;
          padding: 15px 25px;
          border-radius: 12px;
          text-decoration: none;
          font-weight: 600;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        ">
          <span class="material-icons">event</span> Google Calendar
        </a>
        
        <a href="${outlookUrl}" target="_blank" style="
          background: linear-gradient(135deg, var(--primary-medium) 0%, var(--primary-dark) 100%);
          color: white;
          padding: 15px 25px;
          border-radius: 12px;
          text-decoration: none;
          font-weight: 600;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        ">
          <span class="material-icons">email</span> Outlook Calendar
        </a>
        
        <button onclick="DID._downloadICS('${btoa(icsContent)}', '${eventTitle}')" style="
          background: linear-gradient(135deg, var(--primary-light) 0%, var(--primary-medium) 100%);
          color: var(--primary-dark);
          padding: 15px 25px;
          border-radius: 12px;
          border: none;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          font-family: 'Fira Code', monospace;
        ">
          <span class="material-icons">download</span> Descargar .ics
        </button>
      </div>
      
      <button onclick="this.closest('.calendar-modal').remove()" style="
        background: transparent;
        color: rgba(255,255,255,0.6);
        border: 1px solid rgba(255,255,255,0.3);
        padding: 10px 20px;
        border-radius: 8px;
        cursor: pointer;
        font-family: 'Fira Code', monospace;
      ">
        Cerrar
      </button>
    `;
    
    modal.className = 'calendar-modal';
    modal.appendChild(modalContent);
    document.body.appendChild(modal);
    
    // Cerrar modal al hacer clic fuera
    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  // Función para descargar archivo .ics
  function downloadICS(base64Content, filename) {
    const content = atob(base64Content);
    const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename.replace(/\s+/g, '_')}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // Cerrar modal
    const modal = document.querySelector('.calendar-modal');
    if (modal) modal.remove();
  }

  // ===========================================================
  // SHADER BACKGROUND
  // ===========================================================
  
  function initShaderBackground() {
    console.log('Aplicando animación muy simple...');
    
    const countdownSection = document.querySelector('.countdown-section');
    if (!countdownSection) {
      console.warn('Sección de countdown no encontrada');
      return;
    }
    
    // Simplemente usar CSS con animación sutil
    applyFallbackBackground();
    
    function applyFallbackBackground() {
      console.log('Aplicando fondo de respaldo...');
      countdownSection.style.background = `
        linear-gradient(135deg, var(--accent-light) 0%, var(--accent-dark) 100%)
      `;
    }
  }

  // ===========================================================
  // INICIALIZACIÓN GENERAL
  // ===========================================================
  
  function initHomePage() {
    console.log('Inicializando página principal...');
    
    // Inicializar cuenta regresiva solo si estamos en la página principal
    const daysEl = document.getElementById('days');
    const hoursEl = document.getElementById('hours');
    const minutesEl = document.getElementById('minutes');
    const secondsEl = document.getElementById('seconds');
    
    console.log('Elementos de cuenta regresiva encontrados:', {
      days: !!daysEl,
      hours: !!hoursEl,
      minutes: !!minutesEl,
      seconds: !!secondsEl
    });
    
    if (daysEl && hoursEl && minutesEl && secondsEl) {
      initCountdown();
      initShaderBackground();
    }
    
    // Configurar botón de calendario solo si existe
    if (document.getElementById('add-to-calendar')) {
      setupCalendarButton();
    }
  }

  // ---------- init SOLO en voting.html ----------
  function bootVoting(){
    // Si no estamos en voting.html, no ejecutes nada (evita error en Home/Info)
    if (document.body.getAttribute('data-page') !== 'voting') return;

    loadConfiguration();

    // Verificar si se accedió con URL secreta
    const urlParams = new URLSearchParams(window.location.search);
    const secretKey = urlParams.get('admin');
    const isSecretAccess = secretKey === 'config2025' || urlParams.get('config') === '1';
    const hasConfigParam = urlParams.get('config') === '1' || location.hash === '#config';

    // Solo mostrar botón de configuración si se accedió con URL secreta
    if (isSecretAccess) {
      const configAccess = document.getElementById('config-access');
      if (configAccess) {
        configAccess.style.display = 'block';
      }
    }

    // Mostrar config SOLO si se abrió con URL secreta Y PIN correcto
    if (isSecretAccess){
      const pin = prompt('PIN de administrador:');
      if (pin === ADMIN_PIN){
        localStorage.setItem('forceConfig','1'); 
        showConfiguration();
      } else if (pin !== null) {
        alert('PIN incorrecto. Acceso denegado.');
      }
    }
    
    // También permitir acceso con el método anterior (?config=1) para compatibilidad
    // Pero solo si hay parámetros en la URL, no por localStorage
    if (hasConfigParam && !isSecretAccess){
      const pin = prompt('PIN de administrador:');
      if (pin === ADMIN_PIN){
        localStorage.setItem('forceConfig','1'); 
        showConfiguration();
      } else if (pin !== null) {
        alert('PIN incorrecto. Acceso denegado.');
      }
    }

    // Limpiar flag de configuración si no se accedió con URL secreta
    if (!isSecretAccess && !hasConfigParam) {
      localStorage.removeItem('forceConfig');
    }

    // Si ya hay config (del archivo o localStorage), inicializa servicios y muestra login
    if (config.firebase && config.emailjs){
      initializeServices();
      show($('login-section'), true);
    } else if (window.DID_CONFIG && window.DID_CONFIG.firebase && window.DID_CONFIG.emailjs) {
      // Usar configuración del archivo config.js
      config = {
        firebase: window.DID_CONFIG.firebase,
        emailjs: window.DID_CONFIG.emailjs
      };
      initializeServices();
      show($('login-section'), true);
    }
  }

  // Inicialización general
  function boot(){
    initHomePage();
    bootVoting();
  }
  
  document.addEventListener('DOMContentLoaded', boot);

  // Exponer API + algunos internos para botones inline
  return {
    // config
    tryShowConfiguration, showConfiguration, hideConfiguration, saveConfiguration,
    // votación
    sendVerificationCode, verifyCode, confirmGeneration, submitVote, skipCategory,
    // admin
    showAdmin, backToVoting, addCategory, addCandidate,
    exportResults, clearAllData, resetVoting, resetUserVotes, viewUserVotes,
    // gestión de usuarios
    updateUserRole, viewUserInfo,
    // handlers de UI
    handleCategoryTypeChange, handleUserRoleChange,
    logout,
    // helpers internos
    _deleteCandidate: deleteCandidate,
    // funciones para página principal
    _downloadICS: downloadICS
  };
})();
