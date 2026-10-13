# Builds the guide pages (site/guides/*.html), their index, the sitemap and robots.txt from the content below.
# Run: python scripts/build_guides.py   (then deploy the public site)
import html, io, os

SITE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site")
HERE = os.path.join(SITE, "guides")
os.makedirs(HERE, exist_ok=True)
ORIGIN = "https://baptou.com"
CHECKED = {"fr": "13 octobre 2026", "en": "13 October 2026"}

T = {
    "fr": {"guides": "Guides", "home": "Accueil", "legal": "Mentions légales", "privacy": "Politique de confidentialité",
           "checked": "Dates et informations vérifiées le {d} sur les sites officiels. Vérifiez toujours la page officielle avant de candidater.",
           "sources": "Sources", "other": "Read in English", "try": "Essayer BAPTOU", "all": "Tous les guides", "updated": "Mis à jour le {d}."},
    "en": {"guides": "Guides", "home": "Home", "legal": "Legal notice", "privacy": "Privacy policy",
           "checked": "Dates and details checked on {d} on the official websites. Always confirm on the official page before applying.",
           "sources": "Sources", "other": "Lire en français", "try": "Try BAPTOU", "all": "All guides", "updated": "Updated {d}."},
}


def page(lang, slug, other_slug, title, description, body, sources, cta):
    t = T[lang]
    src = "".join(f'<li><a href="{html.escape(u)}" rel="nofollow noopener">{html.escape(label)}</a></li>' for label, u in sources)
    return f"""<!doctype html>
<html lang="{lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)} | BAPTOU</title>
  <meta name="description" content="{html.escape(description)}">
  <link rel="canonical" href="{ORIGIN}/guides/{slug}">
  <link rel="alternate" hreflang="{lang}" href="{ORIGIN}/guides/{slug}">
  <link rel="alternate" hreflang="{'en' if lang == 'fr' else 'fr'}" href="{ORIGIN}/guides/{other_slug}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="BAPTOU">
  <meta property="og:title" content="{html.escape(title)}">
  <meta property="og:description" content="{html.escape(description)}">
  <meta property="og:url" content="{ORIGIN}/guides/{slug}">
  <meta property="og:image" content="{ORIGIN}/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
  <script src="/theme.js"></script>
</head>
<body>
  <main class="guide">
    <header><img src="/logo.svg" alt=""><a href="/" style="color:inherit;text-decoration:none">BAPTOU</a>
      <a class="header-link" href="/guides">{t['guides']}</a></header>
    <p class="crumbs"><a href="/guides">{t['all']}</a> · <a href="/guides/{other_slug}" hreflang="{'en' if lang == 'fr' else 'fr'}">{t['other']}</a></p>
    <h1>{html.escape(title)}</h1>
    <p class="meta">{t['checked'].format(d=CHECKED[lang]) if sources else t['updated'].format(d=CHECKED[lang])}</p>
{body}
    <aside class="cta">
      <p>{cta}</p>
      <p><a class="button" href="https://app.baptou.com">{t['try']}</a></p>
    </aside>
{f'''    <h2>{t['sources']}</h2>
    <ul class="sources">{src}</ul>''' if sources else ''}
    <footer><a href="/">{t['home']}</a> · <a href="/guides">{t['guides']}</a> · <a href="/privacy">{t['privacy']}</a> · <a href="/legal">{t['legal']}</a> · <a href="mailto:baptouai@gmail.com">baptouai@gmail.com</a></footer>
  </main>
</body>
</html>
"""


GUIDES = []

# ---------------------------------------------------------------------------------------------------------------
# 1. Master's application dates
MASTERS_SOURCES = [
    ("ETH Zurich – Master's application dates", "https://ethz.ch/en/studies/master/application/dates.html"),
    ("ETH Zurich – MSc Mechanical Engineering, application", "https://ethz.ch/en/studies/master/application/master-maschinenbau.html"),
    ("EPFL – Master's application & deadlines", "https://www.epfl.ch/education/master/how-to-apply/"),
    ("EPFL – Master admission criteria & application", "https://www.epfl.ch/education/admission/admission-2/master-admission-criteria-application/"),
    ("TU Delft – Dates & deadlines (international diploma)", "https://tudelft.nl/onderwijs/toelating-en-aanmelding/msc-international-diploma/dates-deadlines"),
    ("KTH – How to apply for master's studies", "https://www.kth.se/studies/master/admissions/how-to-apply-for-masters-studies-1.68487"),
    ("TUM – MSc Mechanical Engineering", "https://www.tum.de/en/studies/degree-programs/detail/mechanical-engineering-master-of-science-msc"),
    ("Imperial College London – MSc Advanced Mechanical Engineering", "https://www.imperial.ac.uk/study/courses/postgraduate-taught/advanced-mechanical-engineering/"),
    ("Cranfield University – MSc Automotive Engineering", "https://www.cranfield.ac.uk/courses/taught/automotive-engineering"),
    ("Politecnico di Milano – deadlines for applicants with a foreign degree", "https://www1.polimi.it/en/prospective-students/how-to-apply/admission-to-laurea-magistrale/foreign-qualification/deadlines"),
]

MASTERS_EN = """
    <p class="lead">Most European master's programmes starting in September or October 2027 take applications between October 2026 and May 2027, and the most selective close before Christmas. Here are the dates for eight popular mechanical and automotive engineering programmes, and what to prepare early.</p>

    <div class="table-wrap"><table>
      <thead><tr><th>University</th><th>Programme</th><th>Applications</th><th>Deadline</th><th>Recommendation letters</th><th>Good to know</th></tr></thead>
      <tbody>
        <tr><td><strong>ETH Zurich</strong></td><td>MSc Mechanical Engineering</td><td>1 Nov 2026</td><td><strong>30 Nov 2026</strong>, 11:59 CET (Bachelor's from outside Switzerland)</td><td>2 academic letters</td><td>GRE required if your Bachelor's is not from an EU/EFTA country; one-page motivation letter in English; rank three tutors.</td></tr>
        <tr><td><strong>EPFL</strong></td><td>Master's programmes, e.g. Mechanical Engineering</td><td>Online form</td><td><strong>15 Dec 2026</strong> (paid and validated)</td><td>At least 2 (three referees' contacts; they upload the letters about a week after the deadline)</td><td>15 December is also the deadline for the Excellence Fellowship. Only one master's programme per year at EPFL.</td></tr>
        <tr><td><strong>TU Delft</strong></td><td>MSc Mechanical Engineering</td><td>15 Oct 2026</td><td><strong>15 Jan 2027</strong> (non-EU/EFTA) · <strong>1 Apr 2027</strong> (EU/EFTA)</td><td>See the programme page</td><td>Admission depends on your Bachelor's: check the pathway for a non-Dutch degree.</td></tr>
        <tr><td><strong>KTH</strong> and other Swedish universities</td><td>e.g. MSc Vehicle Engineering</td><td>16 Oct 2026</td><td><strong>15 Jan 2027</strong>; documents by 1 Feb 2027</td><td>Usually none (check the programme)</td><td>One application on University Admissions in Sweden: up to four programmes, ranked.</td></tr>
        <tr><td><strong>TUM</strong></td><td>MSc Mechanical Engineering</td><td>1 Apr 2027</td><td><strong>31 May 2027</strong></td><td>None listed</td><td>Foreign degrees first go through uni-assist (preliminary documentation): start in February. Selection by aptitude assessment. Can be taken in German or in English.</td></tr>
        <tr><td><strong>Imperial College London</strong></td><td>MSc Advanced Mechanical Engineering</td><td>30 Sep 2026</td><td>Rounds: <strong>6 Jan</strong>, 10 Mar, 28 Apr 2027</td><td>See Imperial's application guidance</td><td>£90 application fee. Tuition 2027: £47,250 for overseas students. Later rounds may be full: apply early.</td></tr>
        <tr><td><strong>Cranfield University</strong></td><td>MSc Automotive Engineering</td><td>Open</td><td>No fixed deadline published: apply early</td><td>See the application guide</td><td>One year, starts in October. Tuition 2027-28: £13,700 (home) or £30,500 (overseas).</td></tr>
        <tr><td><strong>Politecnico di Milano</strong></td><td>Laurea Magistrale (MSc) Mechanical Engineering</td><td colspan="2">September intake: windows in <strong>September–November</strong> and <strong>January–March</strong>; the call depends on your nationality</td><td>Check the call</td><td>Non-EU students: use the earliest window, for the visa.</td></tr>
      </tbody>
    </table></div>

    <h2>Recommendation letters: ask now</h2>
    <p>ETH Zurich and EPFL each want <strong>two academic letters</strong>, sent by the referees themselves. Professors receive many requests in November and December, so ask four to six weeks before the deadline. Give each referee your CV, your transcript, the list of programmes with their deadlines, and two or three lines on what you'd like them to highlight (a project you did in their course, your ranking, your internship).</p>

    <h2>What else takes time</h2>
    <ul>
      <li><strong>GRE</strong> for ETH Zurich if your Bachelor's comes from outside the EU/EFTA: book the test early enough for the score to arrive before 30 November.</li>
      <li><strong>uni-assist</strong> for TUM: foreign degrees must be checked before you can apply, which can take several weeks.</li>
      <li><strong>English test</strong> (IELTS, TOEFL, Cambridge) when your degree wasn't taught in English: check each programme's minimum score.</li>
      <li><strong>Fees and funding</strong>: application fees (e.g. £90 at Imperial), tuition (very different between EU and UK universities) and scholarships, whose deadlines often come before the application deadline.</li>
    </ul>

    <h2>A realistic calendar for a September 2027 start</h2>
    <ul>
      <li><strong>October 2026</strong>: shortlist programmes, ask your referees, book any tests. TU Delft, Imperial and Swedish universities are already open.</li>
      <li><strong>November</strong>: ETH Zurich (by 30 November).</li>
      <li><strong>December</strong>: EPFL (by 15 December).</li>
      <li><strong>January 2027</strong>: Imperial round 2 (6 January), KTH and Sweden (15 January), TU Delft for non-EU students (15 January).</li>
      <li><strong>February–March</strong>: Swedish documents (1 February), uni-assist for TUM, Politecnico di Milano's second window, Imperial round 3 (10 March).</li>
      <li><strong>April–May</strong>: TU Delft for EU students (1 April), TUM (1 April to 31 May), Imperial round 4 (28 April).</li>
    </ul>
"""

MASTERS_FR = """
    <p class="lead">La plupart des masters européens qui commencent en septembre ou octobre 2027 prennent les candidatures entre octobre 2026 et mai 2027, et les plus sélectifs ferment avant Noël. Voici les dates de huit masters réputés en génie mécanique et automobile, et ce qu'il faut préparer tôt.</p>

    <div class="table-wrap"><table>
      <thead><tr><th>Université</th><th>Master</th><th>Ouverture</th><th>Date limite</th><th>Lettres de recommandation</th><th>À savoir</th></tr></thead>
      <tbody>
        <tr><td><strong>ETH Zurich</strong></td><td>MSc Mechanical Engineering</td><td>1er nov. 2026</td><td><strong>30 nov. 2026</strong>, 11h59 (licence obtenue hors de Suisse)</td><td>2 lettres académiques</td><td>GRE exigé si votre licence ne vient pas d'un pays de l'UE/AELE ; lettre de motivation d'une page en anglais ; classer trois tuteurs.</td></tr>
        <tr><td><strong>EPFL</strong></td><td>Masters, par ex. Mechanical Engineering</td><td>Formulaire en ligne</td><td><strong>15 déc. 2026</strong> (payé et validé)</td><td>Au moins 2 (coordonnées de trois référents, qui déposent les lettres environ une semaine après la date limite)</td><td>Le 15 décembre est aussi la date limite pour l'Excellence Fellowship. Un seul master par an à l'EPFL.</td></tr>
        <tr><td><strong>TU Delft</strong></td><td>MSc Mechanical Engineering</td><td>15 oct. 2026</td><td><strong>15 janv. 2027</strong> (hors UE/AELE) · <strong>1er avr. 2027</strong> (UE/AELE)</td><td>Voir la page du master</td><td>L'admission dépend de votre licence : consultez la voie « diplôme non néerlandais ».</td></tr>
        <tr><td><strong>KTH</strong> et autres universités suédoises</td><td>par ex. MSc Vehicle Engineering</td><td>16 oct. 2026</td><td><strong>15 janv. 2027</strong> ; pièces justificatives avant le 1er févr. 2027</td><td>En général aucune (vérifiez le master)</td><td>Une seule candidature sur University Admissions in Sweden : jusqu'à quatre masters, classés.</td></tr>
        <tr><td><strong>TUM</strong></td><td>MSc Mechanical Engineering</td><td>1er avr. 2027</td><td><strong>31 mai 2027</strong></td><td>Aucune demandée</td><td>Les diplômes étrangers passent d'abord par uni-assist (préexamen) : commencez en février. Sélection sur dossier (aptitude assessment). Possible en allemand ou en anglais.</td></tr>
        <tr><td><strong>Imperial College London</strong></td><td>MSc Advanced Mechanical Engineering</td><td>30 sept. 2026</td><td>Sessions : <strong>6 janv.</strong>, 10 mars, 28 avr. 2027</td><td>Voir le guide de candidature d'Imperial</td><td>Frais de dossier : 90 £. Frais de scolarité 2027 : 47 250 £ pour les étudiants internationaux. Les dernières sessions peuvent être complètes : candidatez tôt.</td></tr>
        <tr><td><strong>Cranfield University</strong></td><td>MSc Automotive Engineering</td><td>Ouvert</td><td>Pas de date limite publiée : candidatez tôt</td><td>Voir le guide de candidature</td><td>Un an, rentrée en octobre. Frais 2027-28 : 13 700 £ (home) ou 30 500 £ (overseas).</td></tr>
        <tr><td><strong>Politecnico di Milano</strong></td><td>Laurea Magistrale (MSc) Mechanical Engineering</td><td colspan="2">Rentrée de septembre : fenêtres de <strong>septembre à novembre</strong> et de <strong>janvier à mars</strong> ; l'appel dépend de votre nationalité</td><td>Voir l'appel</td><td>Hors UE : prenez la première fenêtre, pour le visa.</td></tr>
      </tbody>
    </table></div>

    <h2>Lettres de recommandation : demandez-les maintenant</h2>
    <p>L'ETH Zurich et l'EPFL demandent chacune <strong>deux lettres académiques</strong>, envoyées par les référents eux-mêmes. Les professeurs reçoivent beaucoup de demandes en novembre et décembre : demandez quatre à six semaines avant la date limite. Donnez à chaque référent votre CV, votre relevé de notes, la liste des masters avec leurs dates, et deux ou trois lignes sur ce que vous aimeriez qu'il souligne (un projet fait dans son cours, votre classement, votre stage).</p>

    <h2>Ce qui prend aussi du temps</h2>
    <ul>
      <li><strong>Le GRE</strong> pour l'ETH Zurich si votre licence vient d'un pays hors UE/AELE : réservez le test assez tôt pour que le score arrive avant le 30 novembre.</li>
      <li><strong>uni-assist</strong> pour la TUM : les diplômes étrangers doivent être vérifiés avant de pouvoir candidater, ce qui peut prendre plusieurs semaines.</li>
      <li><strong>Le test d'anglais</strong> (IELTS, TOEFL, Cambridge) si votre licence n'était pas en anglais : vérifiez le score minimum de chaque master.</li>
      <li><strong>Les frais et les bourses</strong> : frais de dossier (90 £ à Imperial), frais de scolarité (très différents entre l'UE et le Royaume-Uni) et bourses, dont les dates limites arrivent souvent avant celle de la candidature.</li>
    </ul>

    <h2>Un calendrier réaliste pour une rentrée en septembre 2027</h2>
    <ul>
      <li><strong>Octobre 2026</strong> : choisissez vos masters, demandez vos lettres, réservez les tests. TU Delft, Imperial et les universités suédoises sont déjà ouverts.</li>
      <li><strong>Novembre</strong> : ETH Zurich (avant le 30 novembre).</li>
      <li><strong>Décembre</strong> : EPFL (avant le 15 décembre).</li>
      <li><strong>Janvier 2027</strong> : Imperial session 2 (6 janvier), KTH et la Suède (15 janvier), TU Delft hors UE (15 janvier).</li>
      <li><strong>Février–mars</strong> : pièces justificatives en Suède (1er février), uni-assist pour la TUM, deuxième fenêtre de Politecnico di Milano, Imperial session 3 (10 mars).</li>
      <li><strong>Avril–mai</strong> : TU Delft pour l'UE (1er avril), TUM (du 1er avril au 31 mai), Imperial session 4 (28 avril).</li>
    </ul>
"""

GUIDES.append(dict(
    lang="en", slug="masters-2027-application-dates", other="dates-candidatures-masters-2027",
    title="Master's 2027 in mechanical and automotive engineering: application dates and recommendation letters",
    description="Application windows, deadlines and recommendation letters for ETH Zurich, EPFL, TU Delft, KTH, TUM, Imperial, Cranfield and Politecnico di Milano, for a start in autumn 2027.",
    body=MASTERS_EN, sources=MASTERS_SOURCES,
    cta="BAPTOU finds master's programmes that fit your degree and grades, shows when applications open and close, how many recommendation letters each one needs and your chances of admission, then helps you write each application.",
))
GUIDES.append(dict(
    lang="fr", slug="dates-candidatures-masters-2027", other="masters-2027-application-dates",
    title="Masters 2027 en génie mécanique et automobile : dates de candidature et lettres de recommandation",
    description="Ouverture, dates limites et lettres de recommandation pour l'ETH Zurich, l'EPFL, TU Delft, KTH, la TUM, Imperial, Cranfield et Politecnico di Milano, pour une rentrée à l'automne 2027.",
    body=MASTERS_FR, sources=MASTERS_SOURCES,
    cta="BAPTOU trouve les masters adaptés à votre licence et à vos notes, indique quand les candidatures ouvrent et ferment, combien de lettres de recommandation il faut et vos chances d'admission, puis vous aide à rédiger chaque candidature.",
))

# ---------------------------------------------------------------------------------------------------------------
# 2. Cover letter method
LETTER_SOURCES = []  # advice, no dates to source

LETTER_EN = """
    <p class="lead">A recruiter reads a cover letter in under a minute. Most letters fail for the same reasons: they could be sent to any company, they list qualities without proof, and they repeat the CV. This method fixes all three, in four short parts that fit on one A4 page.</p>

    <h2>The four parts</h2>
    <ol class="parts">
      <li><strong>Why them.</strong> One precise reason for choosing this organization: a product, a project, a technology, recent news, something you saw at a forum. "A leader in its field" says nothing; "your switch to by-wire steering on the next platform" says you looked.</li>
      <li><strong>What you bring, with proof.</strong> Two examples from your projects, internships or jobs, chosen to match what the posting asks for. For each: what you did, how, and the result, with a number when you can ("built a test bench that cut measurement time by a third"). Two solid examples beat six adjectives.</li>
      <li><strong>Why this role.</strong> What you want to learn here and how it fits your studies or your plan. Show you understood the job: name one or two of its tasks in your own words.</li>
      <li><strong>Closing.</strong> Your dates (start, duration, or that it's a required internship), an invitation to meet, and the closing formula.</li>
    </ol>

    <h2>The format</h2>
    <ul>
      <li><strong>One A4 page</strong>, with a body of about 250 to 330 words, justified, in a plain font (11 to 12 pt).</li>
      <li><strong>Header</strong>: your name and contact details, the date, the recipient (a name if you found one, otherwise the team and the company, with its address), and a subject line with the posting's title and reference.</li>
      <li><strong>Signature</strong> under the closing: your name, and a scanned signature if you have one.</li>
      <li><strong>File</strong>: a PDF named <em>Lastname_Firstname_CoverLetter_Company.pdf</em>. Some forms ask for the letter and CV in a single PDF: read the instructions.</li>
    </ul>

    <h2>English or French: the conventions change</h2>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>English (UK)</th><th>English (US)</th><th>French</th></tr></thead>
      <tbody>
        <tr><td>Layout</td><td>Your address and the date top right, recipient on the left</td><td>Your details at the top, then date and recipient on the left</td><td>Your details top left, recipient on the right, then "Ville, le date" and "Objet :"</td></tr>
        <tr><td>Name known</td><td>Dear Ms Taylor, … Yours sincerely,</td><td>Dear Ms. Taylor: … Sincerely,</td><td>Madame, … Je vous prie d'agréer, Madame, l'expression de mes salutations distinguées.</td></tr>
        <tr><td>Name unknown</td><td>Dear Sir or Madam, … Yours faithfully, (or "Dear Hiring Manager," … Yours sincerely,)</td><td>Dear Hiring Manager: … Sincerely,</td><td>Madame, Monsieur, … Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.</td></tr>
      </tbody>
    </table></div>
    <p>Write the letter in the posting's language, unless the posting asks otherwise.</p>

    <h2>Phrases to drop</h2>
    <ul>
      <li>"I am a dynamic, motivated and rigorous person": prove it with an example instead.</li>
      <li>"Your company, a leader in its field": find a precise reason.</li>
      <li>"As you can see in my CV": the letter should add what the CV can't say.</li>
      <li>"I am passionate about…" without anything that shows it.</li>
    </ul>

    <h2>Before you send it</h2>
    <ul>
      <li>The company's name, the role and the reference are right (and not the previous company's).</li>
      <li>It fits on one page, and within the form's character limit if you paste it into a field.</li>
      <li>Your dates match what the posting asks for.</li>
      <li>Someone else has read it, or you've read it aloud once.</li>
    </ul>
"""

LETTER_FR = """
    <p class="lead">Un recruteur lit une lettre de motivation en moins d'une minute. La plupart échouent pour les mêmes raisons : elles pourraient être envoyées à n'importe quelle entreprise, elles alignent des qualités sans preuve, et elles répètent le CV. Cette méthode corrige les trois, en quatre parties courtes qui tiennent sur une page A4.</p>

    <h2>Les quatre parties</h2>
    <ol class="parts">
      <li><strong>Pourquoi eux.</strong> Une raison précise de choisir cette entreprise : un produit, un projet, une technologie, une actualité, une rencontre sur un forum. « Leader dans son domaine » ne dit rien ; « votre passage à la direction by-wire sur la prochaine plateforme » montre que vous vous êtes renseigné.</li>
      <li><strong>Ce que vous apportez, avec des preuves.</strong> Deux exemples tirés de vos projets, stages ou jobs, choisis pour répondre à ce que demande l'offre. Pour chacun : ce que vous avez fait, comment, et le résultat, chiffré si possible (« un banc d'essai qui a réduit d'un tiers le temps de mesure »). Deux exemples solides valent mieux que six adjectifs.</li>
      <li><strong>Pourquoi ce poste.</strong> Ce que vous voulez y apprendre et le lien avec vos études ou votre projet. Montrez que vous avez compris le poste : reformulez une ou deux de ses missions.</li>
      <li><strong>Conclusion.</strong> Vos dates (début, durée, ou le fait que le stage est obligatoire), une proposition d'entretien, et la formule de politesse.</li>
    </ol>

    <h2>La forme</h2>
    <ul>
      <li><strong>Une page A4</strong>, avec un corps d'environ 250 à 330 mots, justifié, dans une police sobre (11 à 12 pt).</li>
      <li><strong>En-tête</strong> : vos nom et coordonnées, le destinataire (un nom si vous l'avez trouvé, sinon le service et l'entreprise, avec son adresse), « Ville, le date », et un « Objet : » avec l'intitulé et la référence de l'offre.</li>
      <li><strong>Signature</strong> sous la formule de politesse : votre nom, et une signature scannée si vous en avez une.</li>
      <li><strong>Fichier</strong> : un PDF nommé <em>Nom_Prenom_LettreMotivation_Entreprise.pdf</em>. Certains formulaires demandent la lettre et le CV dans un seul PDF : lisez les consignes.</li>
    </ul>

    <h2>En anglais ou en français : les codes changent</h2>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>Français</th><th>Anglais (Royaume-Uni)</th><th>Anglais (États-Unis)</th></tr></thead>
      <tbody>
        <tr><td>Mise en page</td><td>Vos coordonnées en haut à gauche, le destinataire à droite, puis « Ville, le date » et « Objet : »</td><td>Votre adresse et la date en haut à droite, le destinataire à gauche</td><td>Vos coordonnées en haut, puis la date et le destinataire à gauche</td></tr>
        <tr><td>Nom connu</td><td>Madame, … Je vous prie d'agréer, Madame, l'expression de mes salutations distinguées.</td><td>Dear Ms Taylor, … Yours sincerely,</td><td>Dear Ms. Taylor: … Sincerely,</td></tr>
        <tr><td>Nom inconnu</td><td>Madame, Monsieur, … Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.</td><td>Dear Sir or Madam, … Yours faithfully, (ou « Dear Hiring Manager, » … Yours sincerely,)</td><td>Dear Hiring Manager: … Sincerely,</td></tr>
      </tbody>
    </table></div>
    <p>Écrivez la lettre dans la langue de l'offre, sauf si l'offre demande autre chose.</p>

    <h2>Les formules à bannir</h2>
    <ul>
      <li>« Dynamique, motivé et rigoureux » : prouvez-le plutôt avec un exemple.</li>
      <li>« Votre entreprise, leader dans son domaine » : trouvez une raison précise.</li>
      <li>« Comme vous pouvez le voir sur mon CV » : la lettre doit apporter ce que le CV ne dit pas.</li>
      <li>« Je me permets de vous adresser ma candidature » : entrez directement dans le sujet.</li>
    </ul>

    <h2>Avant d'envoyer</h2>
    <ul>
      <li>Le nom de l'entreprise, le poste et la référence sont justes (et ce n'est pas l'entreprise précédente).</li>
      <li>La lettre tient sur une page, et dans la limite de caractères du formulaire si vous la collez dans un champ.</li>
      <li>Vos dates correspondent à ce que demande l'offre.</li>
      <li>Quelqu'un l'a relue, ou vous l'avez lue à voix haute une fois.</li>
    </ul>
"""

GUIDES.append(dict(
    lang="en", slug="engineering-internship-cover-letter", other="lettre-de-motivation-stage-ingenieur",
    title="Cover letter for an engineering internship: a four-part method that fits on one page",
    description="How to write an engineering internship cover letter recruiters actually read: four parts, one A4 page, the right layout and closing in English or French, and the phrases to drop.",
    body=LETTER_EN, sources=LETTER_SOURCES,
    cta="BAPTOU writes each letter with this method, from your CV and the posting: researched for the company, laid out on one A4 page with the recipient filled in, and ready to save as PDF. You edit, it never sends anything without you.",
))
GUIDES.append(dict(
    lang="fr", slug="lettre-de-motivation-stage-ingenieur", other="engineering-internship-cover-letter",
    title="Lettre de motivation pour un stage d'ingénieur : la méthode en quatre parties, sur une page",
    description="Comment écrire une lettre de motivation de stage d'ingénieur qui se lit : quatre parties, une page A4, la bonne mise en page et formule de politesse en français ou en anglais, et les formules à bannir.",
    body=LETTER_FR, sources=LETTER_SOURCES,
    cta="BAPTOU rédige chaque lettre avec cette méthode, à partir de votre CV et de l'offre : renseignée sur l'entreprise, mise en page sur une page A4 avec le destinataire rempli, prête à enregistrer en PDF. Vous relisez, rien n'est envoyé sans vous.",
))

# ---------------------------------------------------------------------------------------------------------------
# 3. Internships abroad: when they're posted
ABROAD_SOURCES = [
    ("Bosch – Praktikum in der Produktentwicklung neuer Bremssysteme (Germany)", "https://jobs.smartrecruiters.com/BoschGroup/744000151829679-praktikum-in-der-produktentwicklung-neuer-bremssysteme"),
    ("Bosch – Motorsport Engineering Intern (Nuneaton, UK)", "https://jobs.smartrecruiters.com/BoschGroup/744000153670897-motorsport-engineering-intern"),
    ("Applus+ IDIADA – Internship Program Universities (March 2027), Spain", "https://jobs.smartrecruiters.com/ApplusIDIADA1/744000152910874-internship-program-universities-march-2027-applus-idiada"),
    ("BMW Group – International Powertrain & Chassis Product Engineering Intern (Spring 2027), USA", "https://jobs.bmwgroup.com/job/International-Powertrain-&-Chassis-Product-Engineering-Intern-%28Spring-2027%29/191039-en_US/"),
]

ABROAD_EN = """
    <p class="lead">Looking for an internship abroad in 2027? Each country has its own rhythm: when companies post, how long internships last, and which language they expect. Here is what we saw in October 2026 on companies' own careers sites, with real postings as examples.</p>

    <h2>Germany: posted early, 4 to 6 months, often in German</h2>
    <ul>
      <li><strong>When</strong>: internships starting in March or April 2027 were already online in late September and early October 2026. Bosch, for example, posted a brake systems development internship on 25 September: "start from March 2027, 4 to 6 months".</li>
      <li><strong>How long</strong>: usually 4 to 6 months, often as a <em>Pflichtpraktikum</em> (an internship your curriculum requires), with your enrolment certificate and study regulations attached.</li>
      <li><strong>Language</strong>: many postings ask for German, sometimes fluent ("verhandlungssicheres Deutsch"). Motorsport teams and international groups more often work in English.</li>
      <li><strong>Search words</strong>: Praktikum, Pflichtpraktikum, Fahrwerk (chassis), Fahrdynamik (vehicle dynamics), Konstruktion (design), Versuch (testing).</li>
    </ul>

    <h2>United Kingdom: a 12-month placement or a summer internship</h2>
    <ul>
      <li><strong>Placement year</strong>: 12 months, usually from July or September. Bosch's Motorsport Engineering Intern in Nuneaton, for example, is a 12-month internship from July 2027. Applications for 2027 placements open in autumn 2026, and some close as early as September or October.</li>
      <li><strong>Summer internships</strong>: about 10 to 12 weeks, between June and September.</li>
      <li><strong>Right to work</strong>: postings often require the right to live and work in the UK for the whole placement. Since Brexit, EU students without UK status generally need a visa, and many employers don't sponsor interns.</li>
      <li>Internships that start in spring and last four months are rare in the UK.</li>
    </ul>

    <h2>Spain: programmes from March, Spanish is a plus</h2>
    <ul>
      <li>Applus+ IDIADA (vehicle testing and engineering, near Tarragona) posted its 2027 internship programme on 1 October 2026: start in March 2027, 6 to 12 months, for students in their final year, with a good level of English.</li>
      <li><strong>Search words</strong>: prácticas, becario/becaria, ingeniería mecánica.</li>
    </ul>

    <h2>The rest of the EU: no permit, but check language and length</h2>
    <ul>
      <li>As an EU citizen, you can do an internship anywhere in the EU without a work permit: the constraints are the language and the duration.</li>
      <li>Many R&amp;D internships in large groups last around six months; when your school sets a shorter one, say so early.</li>
    </ul>

    <h2>United States: work authorization first</h2>
    <ul>
      <li>US internships require a work authorization or a J-1 visa sponsor. Some groups run programmes for students from foreign universities: BMW's international spring 2027 internship in Spartanburg (South Carolina), for example, runs from early March to mid-September 2027 and asks for a previous BMW internship of at least three months.</li>
    </ul>

    <h2>What this means for you</h2>
    <ul>
      <li><strong>Apply four to six months before your start date</strong>: for an internship in April 2027, from November 2026 to February 2027. For a UK placement starting in July, from September of the year before.</li>
      <li><strong>Read the duration, language and eligibility lines first</strong>: they rule out most postings in seconds.</li>
      <li><strong>If your school sets a shorter internship</strong> (say four months), look for postings that give a range ("4 to 6 months") and say your dates clearly in your letter.</li>
      <li><strong>Search the companies' own sites</strong>, in the local language: job boards keep postings online long after they close.</li>
      <li><strong>Look beyond your favourite industry</strong>: test centres, suppliers, trucks, rail and aerospace use the same skills as car makers and motorsport, with far less competition.</li>
    </ul>
"""

ABROAD_FR = """
    <p class="lead">Vous cherchez un stage à l'étranger en 2027 ? Chaque pays a son rythme : quand les entreprises publient, combien de temps durent les stages, et quelle langue elles attendent. Voici ce que nous avons observé en octobre 2026 sur les sites carrières des entreprises, avec de vraies offres en exemple.</p>

    <h2>Allemagne : publié tôt, 4 à 6 mois, souvent en allemand</h2>
    <ul>
      <li><strong>Quand</strong> : les stages qui commencent en mars ou avril 2027 étaient déjà en ligne fin septembre et début octobre 2026. Bosch, par exemple, a publié le 25 septembre un stage en développement de systèmes de freinage : « début à partir de mars 2027, 4 à 6 mois ».</li>
      <li><strong>Durée</strong> : en général 4 à 6 mois, souvent sous forme de <em>Pflichtpraktikum</em> (stage obligatoire dans votre cursus), avec certificat de scolarité et règlement des études à joindre.</li>
      <li><strong>Langue</strong> : beaucoup d'offres demandent l'allemand, parfois courant (« verhandlungssicheres Deutsch »). Les écuries de sport automobile et les groupes internationaux travaillent plus souvent en anglais.</li>
      <li><strong>Mots-clés</strong> : Praktikum, Pflichtpraktikum, Fahrwerk (châssis), Fahrdynamik (dynamique du véhicule), Konstruktion (conception), Versuch (essais).</li>
    </ul>

    <h2>Royaume-Uni : un stage de 12 mois ou un stage d'été</h2>
    <ul>
      <li><strong>Placement year</strong> : 12 mois, en général à partir de juillet ou septembre. Le stage Motorsport Engineering de Bosch à Nuneaton, par exemple, dure 12 mois à partir de juillet 2027. Les candidatures pour 2027 ouvrent à l'automne 2026, et certaines ferment dès septembre ou octobre.</li>
      <li><strong>Stages d'été</strong> : environ 10 à 12 semaines, entre juin et septembre.</li>
      <li><strong>Droit de travailler</strong> : les offres exigent souvent le droit de vivre et travailler au Royaume-Uni pendant tout le stage. Depuis le Brexit, un étudiant européen sans statut britannique a en général besoin d'un visa, et beaucoup d'entreprises ne parrainent pas les stagiaires.</li>
      <li>Les stages de quatre mois qui commencent au printemps sont rares au Royaume-Uni.</li>
    </ul>

    <h2>Espagne : des programmes dès mars, l'espagnol est un atout</h2>
    <ul>
      <li>Applus+ IDIADA (essais et ingénierie automobile, près de Tarragone) a publié son programme de stages 2027 le 1er octobre 2026 : début en mars 2027, 6 à 12 mois, pour les étudiants en dernière année, avec un bon niveau d'anglais.</li>
      <li><strong>Mots-clés</strong> : prácticas, becario/becaria, ingeniería mecánica.</li>
    </ul>

    <h2>Le reste de l'UE : pas de permis, mais attention à la langue et à la durée</h2>
    <ul>
      <li>Citoyen européen, vous pouvez faire un stage partout dans l'UE sans permis de travail : les contraintes sont la langue et la durée.</li>
      <li>Beaucoup de stages en R&amp;D dans les grands groupes durent environ six mois ; si votre école impose une durée plus courte, dites-le tôt.</li>
    </ul>

    <h2>États-Unis : l'autorisation de travail d'abord</h2>
    <ul>
      <li>Un stage aux États-Unis demande une autorisation de travail ou un visa J-1 parrainé. Certains groupes ont des programmes pour les étudiants d'universités étrangères : le stage international de printemps 2027 de BMW à Spartanburg (Caroline du Sud), par exemple, va de début mars à mi-septembre 2027 et demande un premier stage chez BMW d'au moins trois mois.</li>
    </ul>

    <h2>Ce que ça veut dire pour vous</h2>
    <ul>
      <li><strong>Candidatez quatre à six mois avant le début</strong> : pour un stage en avril 2027, de novembre 2026 à février 2027. Pour un placement au Royaume-Uni en juillet, dès septembre de l'année d'avant.</li>
      <li><strong>Lisez d'abord les lignes durée, langue et éligibilité</strong> : elles éliminent la plupart des offres en quelques secondes.</li>
      <li><strong>Si votre école impose une durée plus courte</strong> (par exemple quatre mois), visez les offres qui donnent une fourchette (« 4 à 6 mois ») et indiquez clairement vos dates dans votre lettre.</li>
      <li><strong>Cherchez sur les sites des entreprises</strong>, dans la langue du pays : les sites d'emploi gardent les offres en ligne longtemps après leur clôture.</li>
      <li><strong>Regardez au-delà de votre secteur préféré</strong> : centres d'essais, équipementiers, poids lourds, ferroviaire et aéronautique demandent les mêmes compétences que les constructeurs et le sport automobile, avec beaucoup moins de concurrence.</li>
    </ul>
"""

GUIDES.append(dict(
    lang="en", slug="internships-abroad-2027", other="stage-etranger-2027",
    title="Internships abroad in 2027: when companies post, how long they last, which language they ask for",
    description="Germany, UK, Spain, the EU, USA: when 2027 engineering internships are posted, their usual length, language and right-to-work requirements, with real examples checked in October 2026.",
    body=ABROAD_EN, sources=ABROAD_SOURCES,
    cta="BAPTOU searches for internships every morning, on companies' own sites, in the countries where you can work and in related industries too. It checks every posting is still open before showing it to you, and prepares each application in the format of its form.",
))
GUIDES.append(dict(
    lang="fr", slug="stage-etranger-2027", other="internships-abroad-2027",
    title="Stage à l'étranger en 2027 : quand les entreprises publient, combien de temps, dans quelle langue",
    description="Allemagne, Royaume-Uni, Espagne, UE, États-Unis : quand sont publiés les stages d'ingénieur 2027, leur durée, la langue et le droit de travailler demandés, avec de vraies offres vérifiées en octobre 2026.",
    body=ABROAD_FR, sources=ABROAD_SOURCES,
    cta="BAPTOU cherche des stages chaque matin, sur les sites des entreprises, dans les pays où vous pouvez travailler et dans les secteurs proches. Il vérifie que chaque offre est toujours ouverte avant de vous la montrer, et prépare chaque candidature au format de son formulaire.",
))

# ---------------------------------------------------------------------------------------------------------------
# Index of the guides, and the sitemap

def index_page():
    def items(lang):
        return "".join(
            f'<li><a href="/guides/{g["slug"]}">{html.escape(g["title"])}</a><span>{html.escape(g["description"])}</span></li>'
            for g in GUIDES if g["lang"] == lang
        )
    return f"""<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Guides | BAPTOU</title>
  <meta name="description" content="Guides gratuits pour les étudiants : dates de candidature des masters 2027, lettre de motivation de stage d'ingénieur, stages à l'étranger. Free guides for students, in English too.">
  <link rel="canonical" href="{ORIGIN}/guides">
  <meta property="og:title" content="Guides BAPTOU">
  <meta property="og:image" content="{ORIGIN}/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
  <script src="/theme.js"></script>
</head>
<body>
  <main class="guide">
    <header><img src="/logo.svg" alt=""><a href="/" style="color:inherit;text-decoration:none">BAPTOU</a>
      <a class="header-link" href="https://app.baptou.com">Sign in</a></header>
    <h1>Guides</h1>
    <p class="lead">Des guides gratuits pour décrocher un stage, une alternance ou un master. Free guides for internships, jobs and master's applications.</p>
    <h2>En français</h2>
    <ul class="guide-list">{items("fr")}</ul>
    <h2>In English</h2>
    <ul class="guide-list">{items("en")}</ul>
    <footer><a href="/">Accueil / Home</a> · <a href="/privacy">Privacy policy</a> · <a href="/legal">Mentions légales</a> · <a href="mailto:baptouai@gmail.com">baptouai@gmail.com</a></footer>
  </main>
</body>
</html>
"""


def main():
    for g in GUIDES:
        out = page(g["lang"], g["slug"], g["other"], g["title"], g["description"], g["body"], g["sources"], g["cta"])
        io.open(os.path.join(HERE, f'{g["slug"]}.html'), "w", encoding="utf-8", newline="\n").write(out)
    io.open(os.path.join(HERE, "index.html"), "w", encoding="utf-8", newline="\n").write(index_page())
    urls = ["/", "/guides", *[f'/guides/{g["slug"]}' for g in GUIDES], "/privacy", "/legal"]
    sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(
        f"  <url><loc>{ORIGIN}{u}</loc></url>\n" for u in urls) + "</urlset>\n"
    io.open(os.path.join(SITE, "sitemap.xml"), "w", encoding="utf-8", newline="\n").write(sitemap)
    io.open(os.path.join(SITE, "robots.txt"), "w", encoding="utf-8", newline="\n").write(f"User-agent: *\nAllow: /\nSitemap: {ORIGIN}/sitemap.xml\n")
    print(f"{len(GUIDES)} guides, index, sitemap ({len(urls)} urls), robots.txt")


if __name__ == "__main__":
    main()
