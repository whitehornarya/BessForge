import { Suspense } from "react";
import { Toaster } from "sonner";
import DesignControlPanel from "./components/DesignControlPanel";
import DesignScene from "./components/DesignScene";
import FeederLegend from "./components/FeederLegend";

function App() {
  return (
    <div className="app-container h-screen w-screen overflow-hidden flex">
      <DesignControlPanel />
      <div className="flex-1 relative">
        <Suspense
          fallback={
            <div className="h-full w-full flex items-center justify-center bg-background">
              <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            </div>
          }
        >
          <DesignScene />
        </Suspense>
        <FeederLegend />
      </div>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
